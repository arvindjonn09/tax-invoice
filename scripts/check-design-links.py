"""Check repository-local Markdown links in the design handoff (stdlib only)."""
from pathlib import Path
import re
from urllib.parse import unquote

root = Path(__file__).resolve().parents[1]
checked = 0
for document in sorted((root / 'docs/design').rglob('*.md')):
    for target in re.findall(r'\[[^\]]+\]\(([^)]+)\)', document.read_text()):
        if '://' in target or target.startswith(('mailto:', '#')):
            continue
        relative = unquote(target.split('#', 1)[0])
        path = (document.parent / relative).resolve()
        assert path.is_relative_to(root), f'{document}: link escapes repository: {target}'
        assert path.is_file(), f'{document}: missing link destination: {target}'
        checked += 1
assert checked > 0, 'No local design links checked'
print(f'PASS: {checked} local design link destinations exist inside the repository')
