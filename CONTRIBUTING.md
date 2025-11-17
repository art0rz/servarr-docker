# Contributing to Servarr Bootstrap

## Development Workflow
1. **Requirements & Planning**
   - Review `bootstrap-requirements.md` before starting work.
   - Align on scope via issues/discussions; keep PRs scoped to a roadmap step when possible.
2. **Environment Setup**
   - Use `./bootstrap.sh --dev` (future) or follow README to create the Python venv.
   - Install dev dependencies via `pip install -r requirements-dev.txt`.
3. **Coding Standards**
   - Favor Typer/Rich idioms, type hints, and static analysis (mypy/ruff once configured).
   - Write modular code with dependency injection for testability.
   - Keep secrets out of logs; reuse utilities from `servarr_bootstrap.logging`.
4. **Testing**
   - Run `python -m ruff check servarr_bootstrap tests` and update/fix lint issues.
   - Add/ update unit tests alongside code changes.
   - Ensure `./bootstrap.sh --dry-run --ci` succeeds locally.
   - For integration work, run bootstrap end-to-end against a dockerized stack before opening a PR.
5. **Git & PRs**
   - Use feature branches; keep commits clean and descriptive.
   - Reference issues in commit/PR descriptions where relevant.
   - Expect automated CI (GitHub Actions) to run lint + tests + smoke bootstrap.
   - Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (e.g., `feat: add sanity scan retries`).
6. **Code Review**
   - Address feedback promptly; be ready to explain design trade-offs.
   - Keep discussions focused on outcomes and user experience.

## Reporting Issues
- Provide environment details (`docker --version`, host OS, etc.).
- Attach relevant log excerpts from `logs/bootstrap-*.log` (scrub secrets first).
- Describe reproduction steps clearly; mention if the issue happens in clean environments.

## Security & Secrets
- Do not share credentials or API keys in issues/PRs.
- If you discover a security flaw, report it privately per the maintainer’s instructions.

Thanks for helping improve the installer!
