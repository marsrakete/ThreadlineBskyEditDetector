# Privacy Policy for Threadline Bluesky Edit & PDS Status

Last updated: September 8, 2026

Threadline Bluesky Edit & PDS Status is a browser extension that identifies supported edited AT Protocol posts and displays connection and Personal Data Server (PDS) status information. This policy explains how the extension handles data while it is running on supported Bluesky, Mu, Blacksky, and Eurosky pages.

## Data the extension reads

The extension reads the following data only to provide its visible features:

- Public post links and public post records, including post text, original text when available, timestamps, handles, DIDs, and record identifiers. This is used to identify and display supported post edits.
- The Bluesky web application's local session record (`BSKY_STORAGE`) on the current supported page. The extension extracts the selected account's handle, DID, PDS address, and sign-in service address to show connection information.
- The PDS address from that session record, when available, to perform an optional direct health check.

The local session record can contain authentication tokens. The extension does not display, store, transmit, or use token fields. It extracts only the account, DID, PDS, and sign-in service fields listed above.

## Network requests

The extension makes HTTPS requests only for its user-facing features:

- To `public.api.bsky.app` for public AT Protocol post records and handle resolution.
- To `status.bsky.app` for Bluesky's published overall service status and component status.
- To the selected PDS at the fixed public path `/xrpc/_health` after the user opens the connection panel. For PDS hosts outside the built-in host list, the browser asks the user to grant access to that specific PDS before the request is made.

PDS health checks omit cookies and authentication credentials. The extension does not send session tokens, passwords, account emails, or post text to a PDS health endpoint. As with any HTTPS request, the service receiving a request may receive technical connection data such as the user's IP address and browser request metadata.

## Storage and retention

The extension does not operate a server and does not send collected data to the developer. It does not create a user account, use analytics, use advertising, or sell or share user data.

Post and status results are kept only in the extension's memory for short-lived display and request caching. The extension does not write Bluesky session data, post data, PDS health results, or connection information to persistent extension storage. Removing the extension clears its in-memory data. Browser-granted optional PDS access can be removed in the browser's extension settings.

## Your choices

You can close the connection panel, deny a requested PDS permission, remove a granted optional PDS permission, disable the extension, or uninstall it at any time. The direct PDS health check is not performed when there is no saved PDS address.

## Changes to this policy

If the extension's data practices change, this policy will be updated before or with the related release.

## Contact

Questions or privacy requests can be submitted through the project's issue tracker: <https://github.com/marsrakete/ThreadlineBskyEditDetector/issues>
