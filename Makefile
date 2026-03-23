.PHONY: dev test lint format setup

setup:
	uv sync
	pnpm install

dev:
	uvicorn openseed_cli.api_server:app --reload --port 8000 &
	cd web && pnpm dev

test:
	pytest packages/*/tests/ -v

test-integration:
	pytest tests/integration/ -v

test-e2e:
	pytest tests/e2e/ -v

lint:
	ruff check packages/ tests/
	ruff format --check packages/ tests/
	mypy packages/

format:
	ruff check --fix packages/ tests/
	ruff format packages/ tests/

doctor:
	openseed doctor
