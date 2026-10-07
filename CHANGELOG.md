# Changelog

## 1.0.3

- Windows: include removable volumes alongside fixed disks.
- Work Status: show every detected disk instead of only the fullest one.
- Panel: move alerts below the metrics and add computer name, OS version and architecture.

## 1.0.2

- The system disk is called "System (/)" in the panel and in warnings instead of just "/".
- macOS: swap is read every 10 seconds instead of every 2, one process start less per tick.
- Internal: the badge is set from a dedicated hook instead of the render callback.

## 1.0.1

- Windows: disks and GPU now show up. PowerShell hung when started from OpenChamber, because the service environment has no `PSModulePath`.

## 1.0.0

First release.

- Rail panel with CPU (overall, per core, two-minute chart, load average), memory and swap, GPUs and disks.
- Compact System section in the Work Status panel.
- Warnings for full disks and memory and for sustained CPU or GPU load, counted on the rail icon badge.
- macOS, Linux and Windows. Linux containers show their CPU and memory limits.
- All 13 OpenChamber languages.
