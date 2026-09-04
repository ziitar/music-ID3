# Provider Cookie Operations

Music ID3 accepts optional Cookie header strings for the unofficial NetEase Cloud Music and QQ Music adapters. Obtain and use Cookies only for an account you are authorized to access. The application does not automate login, collect a password, or refresh an expired Cookie.

## Save, test, and clear

1. Open **Settings** in Music ID3.
2. Select **NetEase** or **QQ Music**.
3. Paste that provider's Cookie and choose **Save Cookie**.
4. Choose **Test** to make a provider request and confirm whether it is currently accepted.
5. Choose **Clear** to remove the selected provider's stored value.

The status shown to the renderer is only `configured` or `unconfigured`; the stored Cookie is never returned to the page. NetEase and QQ values are kept under separate keys, so clearing one does not clear the other. **Clear online cache** removes only current-session response entries and does not remove Cookies.

## Storage and privacy

The encrypted values are stored in `provider-cookies.json` below Electron's `app.getPath("userData")` directory for Music ID3. On a standard Windows installation this is within the current user's roaming application-data area; the exact path can vary with Windows and Electron configuration.

Each value is encrypted using Electron `safeStorage` before the JSON file is written. Decryption occurs only in the Electron main process immediately before the matching provider request. Cookies are excluded from renderer state, error text, and HTTP diagnostics. OS-account access remains the security boundary: encryption at rest is not protection from software already running with access to the same signed-in user and operating-system credentials.

Provider requests necessarily send the configured Cookie to that provider. Local media and CUE files are not uploaded, but search text and provider-specific lookup identifiers are transmitted when you initiate online operations. NetEase and QQ endpoints are unofficial and may change or stop working; the QQ adapter also retains its upstream learning-only/non-commercial warning.

## Limits and troubleshooting

NetEase and QQ requests are dispatched no faster than one every 250 ms per provider, time out after 10 seconds, and retry a transient failure once. Their response cache is memory-only with a five-minute lifetime and is discarded when Music ID3 exits.

If a test fails, confirm that the Cookie belongs to the selected provider, has not expired, and was pasted as a Cookie header string rather than as a password. Clear and save it again after the provider rotates session values. Provider outages, rate limits, changed unofficial endpoints, and offline network state can also cause failures. These failures do not prevent local directory scanning, tag editing, or CUE editing.
