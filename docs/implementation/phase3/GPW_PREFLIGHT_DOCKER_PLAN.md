# GPW preflight — Docker workspace dependency fix

The clean ab74890 Docker build fails with `tools/paper-verify-stack: tsc: not found`.
Docker installs workspace dependencies before copying that workspace's manifest.

Scope: copy tools/paper-verify-stack/package.json before the existing frozen-lockfile
install. Preserve the application source, trading guards, defaults and lockfile.
No trading activation or provider calls are authorized by this change.

Acceptance: independent plan approval, a clean committed-source Docker context
with this patch builds successfully, independent implementation approval, local
lint/typecheck/test/build checks, report, commit and push on main, exact CI check.
Then resume disabled-write PKO preflight. Existing unrelated dirty files must be
preserved. No strategy change means no additional backtest is required.
