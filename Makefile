.PHONY: \
	install install-dev \
	install-backend install-backend-dev install-frontend \
	backend frontend dev \
	test test-backend build-frontend \
	clean help

BACKEND_DIR := backend
FRONTEND_DIR := frontend
VENV := $(BACKEND_DIR)/.venv

# Virtual environments use different executable directories on Windows.
ifeq ($(OS),Windows_NT)
	PYTHON := python
	VENV_BIN := $(VENV)/Scripts
else
	PYTHON := python3
	VENV_BIN := $(VENV)/bin
endif

PY := $(VENV_BIN)/python
NPM := npm

# Display available commands.
help:
	@echo "Available commands:"
	@echo "  make install              Install production dependencies"
	@echo "  make install-dev          Install development dependencies"
	@echo "  make backend              Start FastAPI on port 8000"
	@echo "  make frontend             Start Vite on port 5173"
	@echo "  make dev                  Start backend and frontend"
	@echo "  make test                 Run backend tests"
	@echo "  make build-frontend       Build the production frontend"
	@echo "  make clean                Remove generated dependencies and builds"

# Install production dependencies.
install: install-backend install-frontend

# Install development and testing dependencies.
install-dev: install-backend-dev install-frontend

install-backend:
	$(PYTHON) -m venv $(VENV)
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -r $(BACKEND_DIR)/requirements.txt

install-backend-dev:
	$(PYTHON) -m venv $(VENV)
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -r $(BACKEND_DIR)/requirements-dev.txt

# npm ci uses the committed package-lock.json.
install-frontend:
	cd $(FRONTEND_DIR) && $(NPM) ci

# Run backend at http://127.0.0.1:8000
backend:
	$(PY) -m uvicorn app.main:app \
		--reload \
		--host 0.0.0.0 \
		--port 8000 \
		--app-dir $(BACKEND_DIR)

# Run frontend at http://localhost:5173
frontend:
	cd $(FRONTEND_DIR) && $(NPM) run dev -- --host 0.0.0.0

# Run both processes in parallel.
# Ctrl+C stops the Make job and both child processes.
dev:
	$(MAKE) --no-print-directory -j2 backend frontend

test: test-backend

test-backend:
	$(PY) -m pytest -q $(BACKEND_DIR)/tests

build-frontend:
	cd $(FRONTEND_DIR) && $(NPM) run build

clean:
	rm -rf \
		$(VENV) \
		$(BACKEND_DIR)/.pytest_cache \
		$(BACKEND_DIR)/data \
		$(FRONTEND_DIR)/node_modules \
		$(FRONTEND_DIR)/dist