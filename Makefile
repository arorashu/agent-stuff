SHELL := /bin/bash

SKILL ?=
EXTENSION ?=
PI ?=
BACKUP ?=
DRY ?=
YES ?=
ARGS ?=

.PHONY: help install install-skill install-extension

help:
	@printf '%s\n' \
		'Usage: make install [SKILL="a b"] [EXTENSION="x y"] [PI=0|1] [BACKUP=0|1]' \
		'                  [DRY=0|1] [YES=0|1] [ARGS="--flags"]' \
		'' \
		'Targets:' \
		'  make install                        Install all skills and extensions' \
		'  make install SKILL="a b"            Install specific skills (quote multi-values)' \
		'  make install EXTENSION="x y"        Install specific extensions (quote multi-values)' \
		'  make install-skill NAME=<name>      Install a single skill' \
		'  make install-extension NAME=<name>  Install a single extension' \
		'' \
		'Variables:' \
		'  SKILL, EXTENSION  Selection. If any selector is given, only the explicitly' \
		'                    named items are installed; selectors may be combined.' \
		'  PI=0|1            Force Pi links on/off (default: auto-detect)' \
		'  BACKUP=1          Back up conflicting paths instead of refusing' \
		'  DRY=1             Print the plan without applying' \
		'  YES=1             Skip the confirmation prompt (same as install.sh -y)' \
		'  ARGS              Appended to the install.sh command as shell arguments' \
		'                    (trusted flag strings; validated there),' \
		'                    e.g. ARGS="--dry-run -y"' \
		'' \
		'Conventions:' \
		'  These are make invocation parameters (like make install PREFIX=/opt),' \
		'  not shell environment variables. The prefixed form (VAR=x make) also works' \
		'  via the ?= defaults, but values after the target take precedence.' \
		'  Filesystem locations are configured through environment variables instead:' \
		'  AGENT_SKILLS_DIR, CODEX_SKILLS_DIR, PI_SKILLS_DIR, PI_EXTENSIONS_DIR.' \
		'' \
		'Exit codes: 0 applied/no-op/declined, 1 operational failure, 2 invocation error'

install:
	@for b in "PI:$(PI)" "BACKUP:$(BACKUP)" "DRY:$(DRY)" "YES:$(YES)"; do \
	  case "$${b#*:}" in ""|0|1) ;; \
	    *) printf 'Invalid value for %s: %s (expected 0 or 1)\n' "$${b%%:*}" "$${b#*:}" >&2; exit 2 ;; \
	  esac; \
	done; \
	args=""; \
	if [ -n "$(SKILL)" ]; then for s in $(SKILL); do args="$${args} --skill $$s"; done; fi; \
	if [ -n "$(EXTENSION)" ]; then for e in $(EXTENSION); do args="$${args} --extension $$e"; done; fi; \
	if [ "$(PI)" = "1" ]; then args="$${args} --pi"; fi; \
	if [ "$(PI)" = "0" ]; then args="$${args} --no-pi"; fi; \
	if [ "$(BACKUP)" = "1" ]; then args="$${args} --backup-existing"; fi; \
	if [ "$(DRY)" = "1" ]; then args="$${args} --dry-run"; fi; \
	if [ "$(YES)" = "1" ]; then args="$${args} --yes"; fi; \
	./install.sh $${args} $(ARGS)

install-skill:
	@[ -n "$(NAME)" ] || { echo "Usage: make install-skill NAME=<skill>" >&2; exit 2; }
	$(MAKE) install SKILL=$(NAME)

install-extension:
	@[ -n "$(NAME)" ] || { echo "Usage: make install-extension NAME=<extension>" >&2; exit 2; }
	$(MAKE) install EXTENSION=$(NAME)
