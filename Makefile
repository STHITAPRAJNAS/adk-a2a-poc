PYTHON ?= $(shell [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)

.PHONY: help venv install env run run-remote run-orchestrator stop demo demo-approve demo-reject probe probe-card wrong-resume test lint logs clean

help:  ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

venv:  ## Create .venv
	python3 -m venv .venv

install:  ## Install the project and dev extras into .venv
	$(PYTHON) -m pip install -e ".[dev]"

env:  ## Create .env from the template if it does not exist
	@test -f .env || (cp .env.example .env && echo "wrote .env — add your GOOGLE_API_KEY")

run: env  ## Start both servers in the background
	./scripts/run_all.sh

run-remote:  ## Run the A2A server (release-operations agent) in the foreground
	$(PYTHON) -m servers.remote_agent_server

run-orchestrator:  ## Run the orchestrator + Dev UI in the foreground
	$(PYTHON) -m servers.orchestrator_server

stop:  ## Stop both servers
	./scripts/stop_all.sh

demo:  ## Walk the full flow, prompting for the approval decision
	$(PYTHON) scripts/demo_client.py

demo-approve:  ## Walk the full flow, approving automatically
	$(PYTHON) scripts/demo_client.py --auto-approve

demo-reject:  ## Walk the flow and reject at the approval gate
	$(PYTHON) scripts/demo_client.py --auto-reject

probe-card:  ## Fetch and summarise the remote Agent Card
	$(PYTHON) scripts/a2a_probe.py card

probe:  ## Raw A2A wire trace, including the HITL resume
	$(PYTHON) scripts/a2a_probe.py run --approve

wrong-resume:  ## Show what a plain-text reply does to a paused task
	$(PYTHON) scripts/a2a_probe.py wrong-resume

test:  ## Run the test suite
	$(PYTHON) -m pytest -q

lint:  ## Lint with ruff
	$(PYTHON) -m ruff check .

logs:  ## Follow both server logs
	tail -f logs/remote.log logs/orchestrator.log

clean: stop  ## Stop servers and remove caches
	rm -rf logs .pytest_cache .ruff_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
