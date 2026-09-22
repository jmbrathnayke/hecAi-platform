"""The parity checker must follow removals as well as additions (migration 034 retired SMS)."""
from scripts.check_migration_parity import parse_migrations


def test_dropped_sms_objects_are_no_longer_declared():
    declared, _sources, _files = parse_migrations()
    assert "sms_templates" not in declared["tables"]
    for column in ("cases.citizen_mobile_plain", "cases.twilio_message_sid",
                   "cases.citizen_nic_plain", "users.mobile_number"):
        assert column not in declared["columns"], column


def test_objects_created_alongside_the_removal_are_declared():
    declared, sources, _files = parse_migrations()
    assert "push_templates" in declared["tables"]
    assert sources[("table", "push_templates")] == "034_remove_sms_channel.sql"
    # Unrelated columns from the same early migrations survive.
    assert "cases.submitted_via" in declared["columns"]
