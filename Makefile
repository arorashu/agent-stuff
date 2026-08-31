SHELL := /bin/bash

SKILL ?=
EXTENSION ?=
PI ?=
BACKUP ?=
DRY ?=
YES ?=

.PHONY: help install install-skill install-extension

help:
	@printf '%s\n' \
		'Usage: make install [SKILL=...] [EXTENSION=...] [PI=0|1] [BACKUP=1] [DRY=1] [YES=1]' \
		'' \
		'Targets:' \
		'  make install                      Install all skills and extensions' \
		'  make install SKILL=a b            Install specific skills (space-separated)' \
		'  make install EXTENSION=name       Install specific extensions' \
		'  make install-skill NAME=<name>    Install a single skill' \
		'  make install-extension NAME=<name>  Install a single extension' \
		'' \
		'Variables:' \
		'  SKILL, EXTENSION  What to install (default: all); selecting one kind excludes the other' \
		'  PI=0|1            Force Pi links on/off (default: auto-detect)' \
		'  BACKUP=1          Back up conflicting paths instead of refusing' \
		'  DRY=1             Print the plan without applying' \
		'  YES=1             Skip the confirmation prompt (same as install.sh -y)'

install:
	@args=""; \
	if [ -n "$(SKILL)" ]; then for s in $(SKILL); do args="$${args} --skill $$s"; done; fi; \
	if [ -n "$(EXTENSION)" ]; then for e in $(EXTENSION); do args="$${args} --extension $$e"; done; fi; \
	if [ "$(PI)" = "1" ]; then args="$${args} --pi"; fi; \
	if [ "$(PI)" = "0" ]; then args="$${args} --no-pi"; fi; \
	if [ "$(BACKUP)" = "1" ]; then args="$${args} --backup-existing"; fi; \
	if [ "$(DRY)" = "1" ]; then args="$${args} --dry-run"; fi; \
	if [ "$(YES)" = "1" ]; then args="$${args} --yes"; fi; \
	./install.sh $${args}

install-skill:
	@[ -n "$(NAME)" ] || { echo "Usage: make install-skill NAME=<skill>" >&2; exit 2; }
	$(MAKE) install SKILL=$(NAME)

install-extension:
	@[ -n "$(NAME)" ] || { echo "Usage: make install-extension NAME=<extension>" >&2; exit 2; }
	$(MAKE) install EXTENSION=$(NAME)
