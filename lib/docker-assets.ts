import * as path from 'path';
import * as ecs from 'aws-cdk-lib/aws-ecs';

/**
 * Repository root of this standalone CDK app. `lib/` lives one level below it.
 *
 * The Dockerfiles in `docker/` clone the pinned public Strata source
 * repositories at build time, so the build context only needs this repo.
 */
export const REPO_ROOT = path.join(__dirname, '..');

/**
 * Files that should never be sent to the Docker daemon. The image builds only
 * use `docker/fetch-source.sh`; everything else in the context is noise.
 */
const EXCLUDE = [
  '.git',
  '.github',
  'node_modules',
  'dist',
  'cdk.out',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '*.md',
  'package-lock.json',
];

export interface DockerImageOptions {
  /**
   * Root of a checkout that contains `docker/`. Defaults to this repo.
   * Override when embedding the stacks from another CDK app.
   */
  repoRoot?: string;
  buildArgs?: Record<string, string>;
}

/**
 * Build a container image from one of the Dockerfiles in `docker/`.
 */
export function dockerImage(
  file: string,
  options: DockerImageOptions = {},
): ecs.ContainerImage {
  return ecs.ContainerImage.fromAsset(options.repoRoot ?? REPO_ROOT, {
    file: `docker/${file}`,
    buildArgs: options.buildArgs,
    exclude: EXCLUDE,
  });
}
