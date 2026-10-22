"""Validate design token contrast and the documented rounded evidence (stdlib only)."""
from pathlib import Path


def luminance(colour):
    channels = [int(colour[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return sum(weight * value for weight, value in zip((0.2126, 0.7152, 0.0722), linear))


source = (Path(__file__).resolve().parents[1] / 'docs/design/design-system.md').read_text()
section = source.split('<!-- contrast-pairs:start -->')[1].split('<!-- contrast-pairs:end -->')[0]
checked = 0
for line in section.splitlines():
    if not line.startswith('|') or '#' not in line:
        continue
    name, light_fg, light_bg, dark_fg, dark_bg, light_ratio, dark_ratio = [cell.strip() for cell in line.strip('|').split('|')]
    threshold = 3 if name.startswith(('control-border', 'focus-ring')) else 4.5
    for foreground, background, evidence in ((light_fg, light_bg, light_ratio), (dark_fg, dark_bg, dark_ratio)):
        low, high = sorted((luminance(foreground), luminance(background)))
        ratio = (high + 0.05) / (low + 0.05)
        assert ratio >= threshold, f'{name}: {ratio:.2f} below {threshold}'
        assert f'{ratio:.2f}' == evidence, f'{name}: stale evidence {evidence}'
        checked += 1
assert checked == 26, f'Expected 26 contrast checks, found {checked}'
print(f'PASS: {checked} theme contrast pairs meet thresholds and match documented ratios')
