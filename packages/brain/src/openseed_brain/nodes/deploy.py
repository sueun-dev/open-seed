"""
Deploy node — Push verified code through deployment channels.
REAL implementation — calls openseed_deploy.
"""

from __future__ import annotations

from openseed_brain.state import PipelineState, DeployResult


async def deploy_node(state: PipelineState) -> dict:
    """Deploy the verified implementation via configured channels."""
    working_dir = state["working_dir"]
    task = state["task"]

    try:
        from openseed_deploy.deployer import deploy
        result = await deploy(
            working_dir=working_dir,
            message=f"openseed: {task[:80]}",
        )
        return {
            "deploy_result": result,
            "messages": [f"Deploy: {result.message}"],
        }
    except Exception as e:
        return {
            "deploy_result": DeployResult(success=False, channel="error", message=str(e)),
            "messages": [f"Deploy: error — {e}"],
        }
