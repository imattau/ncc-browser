# Contributing to Nostr Navigator

Thanks for helping make Nostr Navigator better. Contributions of all sizes are
welcome: bug reports, documentation fixes, translations, design feedback, testing,
and code are all useful. You do not need to ask before opening a pull request, and
there is no required issue or proposal process for small changes.

## Getting started

For desktop development, install the dependencies and start the app:

```bash
npm install
npm run dev
```

For Android work, use the repository-local toolchain described in
[`docs/android.md`](docs/android.md). In each shell, activate it with
`source scripts/android-env.sh` before building or using Android tools.

## Making a change

- Keep changes focused and explain the user-visible problem or improvement in your
  pull request.
- Follow the patterns already used in the part of the codebase you are changing.
- Add or update tests when that is useful, especially for shared logic and bug fixes.
- If a change affects setup, behavior, or user-facing flows, update the relevant
  documentation when practical.
- Before submitting, run the checks that make sense for your change. Common options
  include `npm run typecheck`, `npm run lint` and `npm test`; it is fine to say which
  checks you did not run and why.

You are welcome to open a draft pull request early, ask questions in it, or submit
work that is still in progress. Review is a conversation, and maintainers can help
work through feedback together.

## AI-assisted contributions

Use of AI tools is welcomed and encouraged. You may use them to explore the code,
write or revise code and documentation, generate tests, or help debug a problem.
Please review AI-generated work before submitting it: contributors are responsible
for the behavior, accuracy, licensing, and security of what they propose. Mention
AI assistance if it helps reviewers understand the work, but disclosure is not a
condition for contributing.

## Reporting a problem

When reporting a bug, include what you expected, what happened, and steps to
reproduce it if you can. Include your platform and app version when relevant.
Screenshots, logs, and a small example can help, but a report does not need to be
perfect to be useful. Please avoid posting private keys, passwords, or other
secrets.

By contributing, you agree that your contributions are provided under the
project's [MIT license](LICENSE).
