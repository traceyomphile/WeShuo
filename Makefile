.PHONY: install install-backend install-frontend backend frontend dev clean

BACKEND_DIR := backend
FRONTEND_DIR := frontend
VENV := $(BACKEND_DIR)/.venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

# Install everything (Python venv + npm deps)
install: install-backend install-frontend

install-backend:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -r $(BACKEND_DIR)/requirements.txt

install-backend-dev:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -r $(BACKEND_DIR)/requirements-dev.txt

install-frontend:
	cd $(FRONTEND_DIR) && npm install

# Run backend only, http://localhost:8000
backend:
	$(VENV)/bin/uvicorn main:app --reload --port 8000 --app-dir $(BACKEND_DIR)

# Run frontend only, http://localhost:5173
frontend:
	cd $(FRONTEND_DIR) && npm run dev

# Run both at once. Ctrl+C stops both.
dev:
	@trap 'kill 0' EXIT INT TERM; \
	$(VENV)/bin/uvicorn main:app --reload --port 8000 --app-dir $(BACKEND_DIR) & \
	cd $(FRONTEND_DIR) && npm run dev & \
	wait

clean:
	rm -rf $(VENV) $(FRONTEND_DIR)/node_modules $(FRONTEND_DIR)/dist
