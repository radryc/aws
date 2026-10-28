import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { StrataStack } from '../lib/strata-stack';
import { ClientVpnStack } from '../lib/client-vpn-stack';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function makeStack(): ClientVpnStack {
  const app = new cdk.App();
  const strata = new StrataStack(app, 'VpnStrata', {
    env: { account: ACCOUNT, region: REGION },
  });
  return new ClientVpnStack(app, 'ClientVpnStack', {
    env: { account: ACCOUNT, region: REGION },
    serviceNetworkArn: `arn:aws:vpc-lattice:${REGION}:${ACCOUNT}:servicenetwork/sn-test`,
    gatewaySecurityGroup: strata.monofsSg,
    serverCertificateArn: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/server`,
    clientRootCertificateArn: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/client-ca`,
  });
}

describe('ClientVpnStack', () => {
  test('provisions the connectivity VPC, Client VPN endpoint, and Lattice association', () => {
    const stack = makeStack();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::EC2::ClientVpnEndpoint', {
      ClientCidrBlock: '172.16.0.0/22',
      SplitTunnel: true,
      DnsServers: ['10.60.0.2'],
    });
    template.hasResourceProperties('AWS::EC2::ClientVpnAuthorizationRule', {
      TargetNetworkCidr: '10.60.0.0/16',
      AuthorizeAllGroups: true,
    });
    // The VPC local route is created automatically with the target network.
    template.resourceCountIs('AWS::EC2::ClientVpnRoute', 0);
    template.hasResourceProperties('AWS::VpcLattice::ServiceNetworkVpcAssociation', {
      PrivateDnsEnabled: true,
    });
    template.hasOutput('ClientVpnEndpointId', {});
    template.hasOutput('ClientVpnClientCidr', { Value: '172.16.0.0/22' });
  });
});
