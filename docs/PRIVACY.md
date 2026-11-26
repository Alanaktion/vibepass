# Vibepass privacy policy

Vibepass connects to the Bitwarden or Vaultwarden server you choose to authenticate and sync
your account. Your device derives the master password hash and decrypts the vault locally.
When you enable editing, the extension sends encrypted item changes and the metadata your server
needs to apply them. Your server operator controls its access logs and data retention.

Your browser stores your server address, account information, settings, encrypted vault contents
and encrypted refresh token locally. The worker holds the unlocked vault in memory. Browser
session storage carries the unlocked key across worker restarts. Locking clears the key. Logging
out removes the cached vault for the account. Downloaded attachments and copies retained by your
operating system’s clipboard history are under your control.

The extension uses the current page address to match logins locally. The page receives the
credentials you choose to fill. With editing and save offers enabled, Vibepass examines submitted
login fields to offer to save or update them. For passkeys the requesting site receives the
credential response. If you enable site icons, your vault server’s icon service receives the
requested hostnames.

Vibepass has no analytics, advertising, or automatic crash reporting. Feedback you choose to post
on GitHub is subject to GitHub’s privacy policy and the visibility of the issue.
