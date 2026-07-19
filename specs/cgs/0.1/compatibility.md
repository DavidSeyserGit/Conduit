# CGS 0.1 compatibility

CGS versions use semantic version syntax. The `0.1.0` schemas reject artifacts
whose declared version is unsupported; consumers must never guess at the
meaning of an unknown incompatible version. Unknown object fields are retained
by the reference parser where practical so extensions can survive a JSON
round-trip. Clients must ignore fields they do not understand unless a field is
explicitly declared critical by a later specification.

Adding optional fields is compatible within a schema revision. Removing or
renaming fields, changing their meaning, or narrowing accepted values requires
a migration and version change. A future incompatible major version must be
rejected before domain processing. Since CGS is pre-1.0, a minor release may
also intentionally revise contracts and must publish migration guidance.

All model-generated, imported, and persisted objects are validated before use.
Recoverable model schema failures may be sent through a bounded structured
repair attempt. Critical missing fields are never silently synthesized.
Validation diagnostics may be stored for support, but user-facing reports do
not expose stack traces or credentials.

Conduit 0.4 provides the explicit migration marker `0.4.0-cgs-1` for 0.3
development goals. Migration preserves known historical text and decisions and
does not claim missing evidence or approvals existed.
