BIN     := tt
OUTDIR  := dist
ENTRY   := src/index.ts
INSTALL := /usr/local/bin

# Detect platform — used in help text only; bun picks the right target automatically
UNAME := $(shell uname -s)

.PHONY: all build install uninstall clean help

all: build

## build: Compile a standalone binary into ./dist/tt
build:
	@echo "Applying patches..."
	bun scripts/postinstall.ts
	@echo "Building $(BIN)..."
	@mkdir -p $(OUTDIR)
	bun build --compile --minify \
		"--alias:node-datachannel=./stubs/node-datachannel.js" \
		"--alias:utp-native=./stubs/utp-native.js" \
		--outfile=$(OUTDIR)/$(BIN) $(ENTRY)
	@echo "Binary ready: $(OUTDIR)/$(BIN)"

## install: Build and install the binary to $(INSTALL)/tt
##          Uses sudo only for the copy step
install: build
	@echo "Installing $(BIN) to $(INSTALL)/$(BIN)..."
	sudo install -m 755 $(OUTDIR)/$(BIN) $(INSTALL)/$(BIN)
	@echo "Installed. Run 'tt --help' to get started."

## uninstall: Remove the installed binary
uninstall:
	@echo "Removing $(INSTALL)/$(BIN)..."
	sudo rm -f $(INSTALL)/$(BIN)
	@echo "Done."

## clean: Remove the dist/ directory
clean:
	rm -rf $(OUTDIR)
	@echo "Cleaned."

## help: Show this help
help:
	@echo "Usage: make [target]"
	@echo ""
	@grep -E '^## ' Makefile | sed 's/## /  /'
