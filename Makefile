test:
	cd plugin && npm ci && npm run typecheck && npm test
	node .github/scripts/check-bundles.mjs
	node .github/scripts/check-version.mjs
	node .github/scripts/check-sidebar.mjs
