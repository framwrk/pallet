# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Pallet is an Electron desktop application for macOS. Its interface should feel at home on macOS even though its renderer uses web technologies.

## Users

Pallet is primarily for developers and technical operators who need to browse and move files between a Mac and remote servers over SFTP, FTP, explicit FTPS, SMB, or S3-compatible object storage.

## Product Purpose

Pallet makes routine remote file management approachable through a macOS-native-feeling, dual-pane desktop workflow. Success means users can connect, browse, transfer, and manage local and remote files with confidence.

## Positioning

Pallet is a free and open-source, native-feeling macOS file-transfer client for SFTP, FTP, explicit FTPS, SMB, and S3-compatible object storage.

## Operating Context

The workspace starts with local Mac files on the left and a remote server on the right. The left pane can become a second server for remote-to-remote copies. Saved favorites, an inspector, and a transfer queue support repeated workflows; active jobs do not survive app restarts.

## Capabilities and Constraints

- SFTP supports password, private-key, and SSH-agent authentication. FTP, explicit FTPS, and SMB use passwords.
- SMB connections target one share over SMB 2.1 or 3.x with NTLMv2 sign-in, signing and encrypting when the server offers it. Kerberos, guest access, SMB 1, and DFS are out of scope.
- SFTP connections can open an interactive SSH terminal in the pane. It reuses the connection's stored credentials over a second SSH connection, starts in the login home, and stays usable while the file session reconnects.
- S3 connections target one general-purpose bucket with an optional starting key prefix on AWS S3 or a custom http(s) endpoint such as MinIO, Cloudflare R2, or Wasabi. They use explicit static credentials with an optional session token, stored in the same Keychain-backed secret blob as other favorites. Bucket administration, multi-bucket panes, and advanced S3 features are out of scope.
- FTPS validates server certificates by default; users may explicitly relax verification for a trusted private or test server. S3 HTTPS verification is always on.
- It provides dual-pane browsing, local and remote file operations, saved connections, transfers with conflict handling, previews, permissions inspection, and external editing of remote files.
- Transfers are enumerated, staged, checked for size and source changes, then renamed into place. Replacement is atomic locally and on SFTP servers supporting POSIX rename; other servers determine rename behavior. S3 replacements upload to a staging key and copy server-side to the final key, so an existing object survives a failed replacement, but S3 folder renames are not atomic. Optional SHA-256 verification rereads the full source and staged destination before replacement; it is off by default and adds disk/network traffic.
- Pallet ships for Apple silicon on macOS 13 or later, using Electron, React, and TypeScript.
- Current beta omissions and release-specific limitations are documented in [FEATURES.md](FEATURES.md); they are not permanent product commitments.

## Brand Commitments

- The product name is Pallet.
- Pallet is free and open source under the Apache License 2.0.
- The product should feel native to macOS in its interaction patterns and presentation.
- The future visual system should combine Apple liquid-glass material behavior, Raycast-level macOS refinement, and VS Code-like workspace discipline without copying any one product.
- Product language should be direct, calm, and precise about consequential actions.

## Evidence on Hand

- `README.md` contains the public product description, installation status, stack, and licensing information.
- `FEATURES.md` documents the implemented workflows, keyboard conventions, privacy behavior, transfer guarantees, settings, and known beta omissions.
- `build/icon.icns`, `build/icon.ico`, `build/icon.png`, and `src/renderer/src/assets/pallet-icon.png` contain the current product icon assets.
- `test-server/bench-transfers.ts` provides a local benchmark harness. There are no published benchmark results, testimonials, or third-party endorsements in the repository; do not fabricate them.

## Product Principles

1. Protect user data through safe, explicit, and verifiable operations.
2. Be reliable under interruption, network failure, and other real-world transfer conditions.
3. Collect no telemetry and keep credentials and operational data under the user's control.
4. Follow familiar macOS conventions so technical work feels immediate rather than foreign.
5. Keep the core remote-server workflow focused and understandable.
