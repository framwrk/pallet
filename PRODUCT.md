# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Pallet is an Electron desktop application for macOS. Its interface should feel at home on macOS even though its renderer uses web technologies.

## Users

Pallet is primarily for developers and technical operators who need to browse and move files between a Mac and remote servers over SFTP, FTP, or explicit FTPS.

## Product Purpose

Pallet makes routine remote file management approachable through a macOS-native-feeling, dual-pane desktop workflow. Success means users can connect, browse, transfer, and manage local and remote files with confidence.

## Positioning

Pallet is a free and open-source, native-feeling macOS file-transfer client for SFTP, FTP, and explicit FTPS.

## Operating Context

The core workspace places local Mac files in the left pane and a connected remote server in the right pane. Users browse both locations, manage files, and transfer files between them with direct manipulation or keyboard shortcuts. Saved favorites, an inspector, and a persistent transfer queue support repeated server workflows.

## Capabilities and Constraints

- The current product supports SFTP with password or private-key authentication, plus FTP and explicit FTPS with password authentication.
- FTPS validates server certificates by default; users may explicitly relax verification for a trusted private or test server.
- It provides dual-pane browsing, local and remote file operations, saved connections, transfers with conflict handling, previews, permissions inspection, and external editing of remote files.
- Transfers are enumerated, staged to temporary files, atomically renamed, and verified. Interrupted or unsafe operations must fail visibly rather than leave silently corrupted results.
- Pallet currently targets macOS and is distributed as an Electron application built with React and TypeScript.
- Current beta omissions and release-specific limitations are documented in `FEATURES.md`; they are not permanent product commitments.

## Brand Commitments

- The product name is Pallet.
- Pallet is free and open source under the Apache License 2.0.
- The product should feel native to macOS in its interaction patterns and presentation.
- The future visual system should combine Apple liquid-glass material behavior, Raycast-level macOS refinement, and VS Code-like workspace discipline without copying any one product.
- Product language should be direct, calm, and precise about consequential actions.

## Evidence on Hand

- `README.md` contains the public product description, installation status, stack, and licensing information.
- `FEATURES.md` documents the implemented workflows, keyboard conventions, privacy behavior, transfer guarantees, settings, and known beta omissions.
- `build/icon.icns`, `build/icon.ico`, `build/icon.png`, and `resources/icon.png` contain the current product icon assets.
- The repository does not contain testimonials, customer claims, benchmarks, or other third-party proof; future work must not fabricate them.

## Product Principles

1. Protect user data through safe, explicit, and verifiable operations.
2. Be reliable under interruption, network failure, and other real-world transfer conditions.
3. Collect no telemetry and keep credentials and operational data under the user's control.
4. Follow familiar macOS conventions so technical work feels immediate rather than foreign.
5. Keep the core remote-server workflow focused and understandable.
