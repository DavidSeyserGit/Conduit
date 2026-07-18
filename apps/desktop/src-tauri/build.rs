fn main() {
    const COMMANDS: &[&str] = &[
        "tool_execute",
        "report_export_write",
        "github_client_id",
        "github_get_token",
        "github_store_token",
        "github_device_start",
        "github_device_poll",
        "openrouter_get_key",
        "openrouter_store_key",
        "git_clone_repo",
        "git_worktree_create",
        "git_worktree_remove",
        "git_handoff_status",
        "git_commit_changes",
        "git_push_branch",
        "local_harness_models",
        "local_harness_health",
        "local_harness_response",
        "local_harness_coding_iteration",
        "local_harness_cancel",
        "goal_storage_status",
        "goal_storage_write",
        "goal_storage_read",
        "goal_artifact_write",
        "goal_artifact_read",
        "goal_artifact_cleanup",
    ];

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}
