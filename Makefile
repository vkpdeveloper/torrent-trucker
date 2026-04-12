BIN     := tt
OUTDIR  := dist
ENTRY   := src/index.ts
INSTALL := /usr/local/bin
DOTENV  := .env

.PHONY: all build install install-service uninstall clean help

all: build

## build: Compile a standalone binary into ./dist/tt
##        Reads .env and bakes all variables into the binary at build time.
##        Override the env file: make build DOTENV=/path/to/other.env
build:
	@test -f $(DOTENV) || (echo "Error: $(DOTENV) not found. Copy .env.example and fill it in."; exit 1)
	@echo "Applying patches..."
	@bun scripts/postinstall.ts
	@echo "Building $(BIN) (embedding $(DOTENV))..."
	@mkdir -p $(OUTDIR)
	@set -a && . ./$(DOTENV) && set +a && \
	bun build --compile --minify \
		--no-compile-autoload-dotenv \
		--env="*" \
		"--alias:node-datachannel=./stubs/node-datachannel.js" \
		"--alias:utp-native=./stubs/utp-native.js" \
		--outfile=$(OUTDIR)/$(BIN) $(ENTRY)
	@echo "Binary ready: $(OUTDIR)/$(BIN)"

## install: Build then install to $(INSTALL)/tt (uses sudo for the copy)
install: build
	@echo "Installing $(BIN) to $(INSTALL)/$(BIN)..."
	sudo install -m 755 $(OUTDIR)/$(BIN) $(INSTALL)/$(BIN)
	@echo "Installed. Run 'tt --help' to get started."

## install-service: Install and enable the systemd service
install-service:
	sudo cp torrent-trucker.service /etc/systemd/system/
	sudo systemctl daemon-reload
	sudo systemctl enable torrent-trucker
	sudo systemctl restart torrent-trucker
	@sleep 2
	sudo systemctl status torrent-trucker

## uninstall: Remove the installed binary
uninstall:
	@echo "Removing $(INSTALL)/$(BIN)..."
	sudo rm -f $(INSTALL)/$(BIN)
	@echo "Done."

## clean: Remove the dist/ directory
clean:
	rm -rf $(OUTDIR)
	@echo "Cleaned."

## help: Show available targets
help:
	@echo "Usage: make [target] [DOTENV=path/to/.env]"
	@echo ""
	@grep -E '^## ' Makefile | sed 's/## /  /'
