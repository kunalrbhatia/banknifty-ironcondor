# Pull Request Workflow Rules

- **Branch Protection**: Never commit or push code changes directly to the `master`, `main`, or `development` branches.
- **Workflow**: Always use the `.agents/skills/gh-pr-workflow` skill to create a feature branch, commit changes, push, and open a descriptive pull request for review.
- **PR Descriptions Formatting**: When creating or editing pull requests using the GitHub CLI (`gh`), always write the description to a temporary file and pass it via the `--body-file` flag. This avoids shell-specific newline (`\n` or `` `n ``) and backtick escaping problems.
- **PR Merging Method**: When merging pull requests using the GitHub CLI (`gh`), always use the squash and merge method (by passing the `--squash` flag).
- **Linear History**: All commits on `master` / `main` must maintain a clean, strictly linear commit history without merge commits. Feature branches must be squashed into a single commit when merging.
