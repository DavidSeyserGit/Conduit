mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::tool_execute,
            commands::tool_list_files,
            commands::tool_read_file,
            commands::tool_write_file,
            commands::tool_search_files,
            commands::tool_run_command,
            commands::tool_get_git_diff,
            commands::github_client_id,
            commands::github_get_token,
            commands::github_store_token,
            commands::openrouter_get_key,
            commands::openrouter_store_key,
            commands::git_clone_repo,
            commands::git_worktree_create,
            commands::git_worktree_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
