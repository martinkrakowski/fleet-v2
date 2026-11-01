# Staging

Staging is deployed from the private platform repository, by GitOps. There is no deploy command in this repository.

On `main`, `build-image.yml` pushes the image by digest and records it in the job summary. A pull request to the platform repository promotes that digest, and merging it is the deploy.

## API Configuration and Activation

Staging stays 501 until the owner creates a mode-600 token file, mounts it as a Secret, and sets `FLEET_STATE_DIR` and `FLEET_API_TOKEN_FILE`. Do not add or commit any secret value.
