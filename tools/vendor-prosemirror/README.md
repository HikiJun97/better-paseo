# vendor-prosemirror (dev only)

Produces `client/vendor/prosemirror.js`: the ProseMirror modules the rich
composer uses (`client/composer/`), bundled into one ESM file, lowered with the
class-only Babel plugins so the plugin client loads under Hermes, then minified
with esbuild (target es2020, every non-ASCII character escaped). Their types are
copied to `client/vendor/prosemirror-types/` with the package specifiers
rewritten, and `prosemirror.d.ts` re-exports them. The generated files and the
MIT licences are committed; this package is not a dependency of the plugin.

```
cd tools/vendor-prosemirror
npm ci
npm run build      # rewrites client/vendor/prosemirror.{js,d.ts,LICENSE} and prosemirror-types/
```

To upgrade, bump the versions in `package.json` (exact), run `npm install`,
then `npm run build`, and run `npm run check:hermes` at the repo root. The build
fails if any class, private name or static block survives the lowering, or if
a non-ASCII character is left.

The editor is about 240 KB minified. It ships in the Tasks chunk, not the
bundle (`client/tasks/chunk/entry.ts`), so phones do not download it on every
reconnect.
