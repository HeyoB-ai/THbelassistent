# Alternatief voor de Dockerfile, voor buildpack-platforms (Railway/Heroku/Fly)
# die geen container bouwen. De Dockerfile is de aanbevolen route; zie README.
#
# Hier stond eerder `npm run worker:build && npm run worker:start`. Dat riep tsc
# aan bij ELKE start, terwijl tsc in een productie-install (--omit=dev) niet
# bestaat: "sh: 1: tsc: not found", en de worker kwam nooit op. Compileren hoort
# in de build-fase, niet in de start. Die fase draait `npm run build`, en dat
# script compileert de worker mee.
worker: npm run worker:start
