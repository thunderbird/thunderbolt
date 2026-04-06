import * as aws from '@pulumi/aws'
import * as dockerBuild from '@pulumi/docker-build'

export const createEcrAndImages = (name: string) => {
  const backendRepo = new aws.ecr.Repository(`${name}-backend`, {
    forceDelete: true,
    tags: { Name: `${name}-backend` },
  })

  const frontendRepo = new aws.ecr.Repository(`${name}-frontend`, {
    forceDelete: true,
    tags: { Name: `${name}-frontend` },
  })

  const authToken = aws.ecr.getAuthorizationTokenOutput({
    registryId: backendRepo.registryId,
  })

  const backendImage = new dockerBuild.Image(`${name}-backend-image`, {
    tags: [backendRepo.repositoryUrl.apply((url) => `${url}:latest`)],
    context: { location: '../../../' },
    dockerfile: { location: '../../../deploy/docker/backend.Dockerfile' },
    platforms: ['linux/amd64'],
    push: true,
    registries: [
      {
        address: backendRepo.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
      },
    ],
  })

  const frontendImage = new dockerBuild.Image(`${name}-frontend-image`, {
    tags: [frontendRepo.repositoryUrl.apply((url) => `${url}:latest`)],
    context: { location: '../../../' },
    dockerfile: { location: '../../../deploy/docker/frontend.Dockerfile' },
    buildArgs: {
      VITE_THUNDERBOLT_CLOUD_URL: '/v1',
      VITE_AUTH_MODE: 'oidc',
    },
    platforms: ['linux/amd64'],
    push: true,
    registries: [
      {
        address: frontendRepo.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
      },
    ],
  })

  const postgresRepo = new aws.ecr.Repository(`${name}-postgres`, {
    forceDelete: true,
    tags: { Name: `${name}-postgres` },
  })

  const postgresImage = new dockerBuild.Image(`${name}-postgres-image`, {
    tags: [postgresRepo.repositoryUrl.apply((url) => `${url}:latest`)],
    context: { location: '../../../' },
    dockerfile: { location: '../../../deploy/docker/postgres.Dockerfile' },
    platforms: ['linux/amd64'],
    push: true,
    registries: [
      {
        address: postgresRepo.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
      },
    ],
  })

  const keycloakRepo = new aws.ecr.Repository(`${name}-keycloak`, {
    forceDelete: true,
    tags: { Name: `${name}-keycloak` },
  })

  const keycloakImage = new dockerBuild.Image(`${name}-keycloak-image`, {
    tags: [keycloakRepo.repositoryUrl.apply((url) => `${url}:latest`)],
    context: { location: '../../../' },
    dockerfile: { location: '../../../deploy/docker/keycloak.Dockerfile' },
    platforms: ['linux/amd64'],
    push: true,
    registries: [
      {
        address: keycloakRepo.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
      },
    ],
  })

  const powersyncRepo = new aws.ecr.Repository(`${name}-powersync`, {
    forceDelete: true,
    tags: { Name: `${name}-powersync` },
  })

  const powersyncImage = new dockerBuild.Image(`${name}-powersync-image`, {
    tags: [powersyncRepo.repositoryUrl.apply((url) => `${url}:latest`)],
    context: { location: '../../../' },
    dockerfile: { location: '../../../deploy/docker/powersync.Dockerfile' },
    platforms: ['linux/amd64'],
    push: true,
    registries: [
      {
        address: powersyncRepo.repositoryUrl,
        username: authToken.userName,
        password: authToken.password,
      },
    ],
  })

  return {
    backendRepo, frontendRepo, postgresRepo, keycloakRepo, powersyncRepo,
    backendImage, frontendImage, postgresImage, keycloakImage, powersyncImage,
  }
}
