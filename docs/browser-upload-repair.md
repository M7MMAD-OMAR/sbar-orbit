# Confined browser file upload repair

The old upload implementation handed host paths to Playwright. A browser inside the network and filesystem namespace could create a selected-file entry but could not read the host file. The action acknowledgement therefore did not establish delivery of bytes to the page.

The repair passes authorized file contents through Playwright's documented in-memory file payload. The browser still receives no host directory mount. Native file-input and file-chooser routes use the same payload, MIME type and basename. Returned byte counts describe the transferred buffers. The policy still classifies upload as irreversible.

Combined payloads are limited to 50 MiB. Larger files are explicitly refused, rather than acknowledged as usable inside the namespace. This is a practical bound for the in-memory Playwright path, not a general file-bridge implementation. A file changing between validation and read is not an atomic snapshot guarantee.

On October 6, 2026, the existing readback fixture was changed to a bounded-origin session. Against the original implementation it failed: the action reported delivery but the page received no readable content. After the repair, ordinary and namespace sessions both read back the exact contents through the input and chooser. The focused run passed 3 tests and 20 assertions. TypeScript passed. These are local Fedora results, not all-platform verification.

An actual 2,791,191-byte MP4 then completed native X processing, showed its correct poster and 0:42 duration, and reached Ready. Separate pointer-action failures prevented publication; successful media processing is not a successful post receipt. The repair was used in a separate local worktree and broker. The shared managed installation was not changed or restarted.

References: [Playwright setInputFiles](https://playwright.dev/docs/api/class-locator#locator-set-input-files) documents buffers with name, MIME type and contents. The focused fixture is `tests/browser-upload.test.ts`.
