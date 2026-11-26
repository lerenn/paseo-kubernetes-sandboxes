test:
	cd plugin && npm ci && npm run typecheck && npm test
	node .github/scripts/check-version.mjs
