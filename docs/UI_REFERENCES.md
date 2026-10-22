# UI sources and licence decisions

Issue #19 incorporates only the following third-party UI code/assets. Resolved versions are locked in `pnpm-lock.yaml`; new runtime packages are pinned. No competitor branding, layouts, screenshots or restricted invoice code are copied.

| Source | Version / revision | Licence | Incorporation and decision |
| --- | --- | --- | --- |
| [shadcn/ui](https://github.com/shadcn-ui/ui/tree/3d98900e9b73c45f035f8109e9d41ba6a51685e7) | `3d98900e9b73c45f035f8109e9d41ba6a51685e7` | MIT | Adapted the new-york-v4 Button structure; replaced geometry, colours, opacity and focus rules with JobFlow tokens and accessible disabled colours. Copyright/permission notice retained in [third-party licence](../third-party/shadcn-ui-LICENSE.md). `components.json`, aliases, `cn` and a Radix-backed Button initialise the manual setup. |
| [Geist](https://github.com/vercel/geist-font) | npm `geist` 1.8.2 | SIL OFL 1.1 | Unmodified variable sans font through `geist/font/sans` and `next/font/local`, bundled and served by this app; no Google/Vercel font requests at build or runtime. Distribution permitted with copyright and OFL; retain [full OFL](../third-party/geist-OFL.txt). Do not sell the font alone or rename modified fonts using reserved names. |
| [next-themes](https://github.com/pacocoursey/next-themes) | 0.4.6 | MIT | Theme preference persistence, pre-paint script, OS changes and storage-denial handling. Retain package licence. Inline pre-paint script must receive a nonce if a future CSP requires one. |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | 4.3.3 | MIT | CSS-first v4 `@theme inline` and PostCSS integration. No v3 config file is required; shadcn's config field is intentionally empty. |
| [Radix Slot](https://github.com/radix-ui/primitives) | 1.5.0 | MIT | Installed dependency for Button's `asChild` composition; retain package licence. |
| [CVA](https://github.com/joe-bell/cva) | 0.7.1 | Apache-2.0 | Installed button variant helper; retain Apache package licence and notices. |
| [clsx](https://github.com/lukeed/clsx) / [tailwind-merge](https://github.com/dcastil/tailwind-merge) | 2.1.1 / 3.7.0 | MIT | Class composition helper dependencies; retain package licences. |
| [axe-core Playwright](https://github.com/dequelabs/axe-core-npm) | 4.14.0 | MPL-2.0 | Unmodified development/test dependency only, not shipped in application runtime; no source files copied or modified. |

Package licences and upstream shadcn's MIT notice were inspected before reuse. The original JobFlow token table remains the authority for colours. Native select semantics implement the appearance control; status symbols and all layout/component sample text are original.
