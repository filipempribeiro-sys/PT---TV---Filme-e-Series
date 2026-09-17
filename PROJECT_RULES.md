# PROJECT RULES — GitHub Actions

## Mandatory operating rule

GitHub Actions minutes must be protected during normal development.

- Checkpoints, routine commits and rollbacks must NOT intentionally trigger builds, releases, wake jobs or other expensive CI jobs.
- Build/release workflows must remain manual (`workflow_dispatch`) unless Filipe explicitly authorizes an automatic trigger.
- Render/backend wake workflows must remain manual (`workflow_dispatch`) unless Filipe explicitly authorizes reactivation of a schedule.
- Do not add or reactivate `schedule`, broad `push`, `pull_request` or other automatic triggers for expensive jobs without explicit authorization from Filipe.
- Before adding or changing `.github/workflows/`, audit the resulting automatic Actions impact.
- A change that introduces new automatic GitHub Actions consumption is a CRITICAL CHANGE and requires Filipe's approval before implementation.

## Development principle

Normal coding and checkpointing should consume zero GitHub-hosted runner minutes whenever technically possible.
