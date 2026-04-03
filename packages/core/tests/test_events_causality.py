"""
Tests for event causality tracking — OpenHands pattern integration.
"""

from __future__ import annotations

import pytest
from openseed_core.events import Event, EventBus, EventType


class TestEventCausality:
    def test_event_has_unique_id(self) -> None:
        e1 = Event(type=EventType.NODE_START)
        e2 = Event(type=EventType.NODE_START)
        assert e1.id != e2.id
        assert len(e1.id) > 10  # UUID format

    def test_event_cause_id_default_none(self) -> None:
        e = Event(type=EventType.NODE_START)
        assert e.cause_id is None

    def test_event_cause_chain(self) -> None:
        parent = Event(type=EventType.PIPELINE_START, node="pipeline")
        child = Event(type=EventType.NODE_START, node="intake", cause_id=parent.id)
        assert child.cause_id == parent.id

    @pytest.mark.asyncio
    async def test_emit_simple_with_cause_id(self) -> None:
        bus = EventBus()
        events: list[Event] = []

        async def capture(event: Event) -> None:
            events.append(event)

        bus.subscribe(capture)

        parent = Event(type=EventType.PIPELINE_START)
        await bus.emit(parent)
        await bus.emit_simple(
            EventType.NODE_START,
            node="intake",
            cause_id=parent.id,
            task="test",
        )

        assert len(events) == 2
        assert events[1].cause_id == events[0].id

    def test_new_event_types_exist(self) -> None:
        assert EventType.SENTINEL_STUCK == "sentinel.stuck"
        assert EventType.SECURITY_CHECK == "security.check"
        assert EventType.METRICS_UPDATE == "metrics.update"
