import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as vpclattice from 'aws-cdk-lib/aws-vpclattice';
import { Construct } from 'constructs';

export const K8S_CONNECTIVITY_VPC_CIDR = '10.60.0.0/16';
export const K8S_CLIENT_VPN_CIDR = '172.16.0.0/22';
export const K8S_CONNECTIVITY_DNS = '10.60.0.2';

export interface ClientVpnStackProps extends cdk.StackProps {
  /** Lattice service network owned by ObservabilityStack. */
  serviceNetworkArn: string;
  /** Security group attached to the OTLP gateway tasks/ALB. */
  gatewaySecurityGroup: ec2.ISecurityGroup;
  /** ACM ARN for the Client VPN server certificate. */
  serverCertificateArn: string;
  /** ACM ARN for the client root CA used by mutual authentication. */
  clientRootCertificateArn: string;
}

/**
 * Connectivity-only VPC and AWS Client VPN endpoint for a local kind
 * workload cluster.
 *
 * Traffic flow:
 *
 *   local kind -> Client VPN -> connectivity VPC -> Lattice service network
 *   -> OTLP gateway in the Strata VPC
 *
 * This endpoint is intentionally client-initiated only. AWS resources cannot
 * initiate connections back to a connected VPN client; the public reverse
 * tunnel used by the k8s-control profile is a separate mechanism.
 */
export class ClientVpnStack extends cdk.Stack {
  public readonly endpointId: string;
  public readonly vpc: ec2.Vpc;
  public readonly clientCidrBlock = K8S_CLIENT_VPN_CIDR;

  constructor(scope: Construct, id: string, props: ClientVpnStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'K8sConnectivityVpc', {
      ipAddresses: ec2.IpAddresses.cidr(K8S_CONNECTIVITY_VPC_CIDR),
      maxAzs: 2,
      natGateways: 0,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    this.vpc = vpc;
    const privateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    }).subnets;
    if (privateSubnets.length < 2) {
      throw new Error('Client VPN connectivity VPC requires two private subnets');
    }

    const vpnSg = new ec2.SecurityGroup(this, 'ClientVpnSg', {
      vpc,
      description: 'AWS Client VPN endpoint',
      allowAllOutbound: true,
    });

    // Lattice association security group. Traffic from the VPN client CIDR
    // enters this VPC and is forwarded through the service network.
    const latticeSg = new ec2.SecurityGroup(this, 'LatticeConnectivitySg', {
      vpc,
      description: 'Local kind clients to VPC Lattice',
      allowAllOutbound: true,
    });
    latticeSg.addIngressRule(
      ec2.Peer.ipv4(K8S_CLIENT_VPN_CIDR),
      ec2.Port.tcp(4318),
      'Client VPN clients to Lattice OTLP',
    );

    // The gateway sees traffic from the connectivity VPC/Lattice ENIs. Keep
    // the rule explicit so the VPN path does not depend on a shared SG.
    props.gatewaySecurityGroup.addIngressRule(
      ec2.Peer.ipv4(K8S_CONNECTIVITY_VPC_CIDR),
      ec2.Port.tcp(4318),
      'Client VPN connectivity VPC to OTLP gateway',
    );

    const endpoint = new ec2.CfnClientVpnEndpoint(this, 'ClientVpnEndpoint', {
      clientCidrBlock: K8S_CLIENT_VPN_CIDR,
      serverCertificateArn: props.serverCertificateArn,
      authenticationOptions: [
        {
          type: 'certificate-authentication',
          mutualAuthentication: {
            clientRootCertificateChainArn: props.clientRootCertificateArn,
          },
        },
      ],
      connectionLogOptions: { enabled: false },
      splitTunnel: true,
      dnsServers: [K8S_CONNECTIVITY_DNS],
      vpcId: vpc.vpcId,
      securityGroupIds: [vpnSg.securityGroupId],
      transportProtocol: 'udp',
      description: 'Strata local kind connectivity',
    });
    this.endpointId = endpoint.ref;

    const targetNetworks = privateSubnets.map((subnet, index) => {
      const association = new ec2.CfnClientVpnTargetNetworkAssociation(
        this,
        `TargetNetwork${index + 1}`,
        {
          clientVpnEndpointId: endpoint.ref,
          subnetId: subnet.subnetId,
        },
      );
      association.node.addDependency(endpoint);
      return association;
    });

    const authorization = new ec2.CfnClientVpnAuthorizationRule(this, 'AuthorizeVpc', {
      clientVpnEndpointId: endpoint.ref,
      targetNetworkCidr: K8S_CONNECTIVITY_VPC_CIDR,
      authorizeAllGroups: true,
      description: 'Allow local kind clients into the connectivity VPC',
    });
    authorization.node.addDependency(...targetNetworks);

    // The VPC local route (10.60.0.0/16) is added automatically when the first
    // target network is associated. Creating it explicitly fails with
    // "Route already exists". Only the authorization rule is needed here.

    new vpclattice.CfnServiceNetworkVpcAssociation(this, 'LatticeAssociation', {
      serviceNetworkIdentifier: props.serviceNetworkArn,
      vpcIdentifier: vpc.vpcId,
      securityGroupIds: [latticeSg.securityGroupId],
      privateDnsEnabled: true,
    });

    new cdk.CfnOutput(this, 'ClientVpnEndpointId', {
      value: endpoint.ref,
      description: 'AWS Client VPN endpoint for local kind',
    });
    new cdk.CfnOutput(this, 'ClientVpnVpcCidr', {
      value: K8S_CONNECTIVITY_VPC_CIDR,
      description: 'Connectivity VPC CIDR',
    });
    new cdk.CfnOutput(this, 'ClientVpnClientCidr', {
      value: K8S_CLIENT_VPN_CIDR,
      description: 'Client VPN address pool',
    });
    new cdk.CfnOutput(this, 'ClientVpnDnsServer', {
      value: K8S_CONNECTIVITY_DNS,
      description: 'VPC resolver pushed to VPN clients',
    });
  }
}
