use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub entry_type: String,
    pub size: Option<u64>,
}

fn normalize_path(workspace: &str, target: &str) -> Result<PathBuf, String> {
    let workspace = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| format!("Invalid workspace: {e}"))?;

    let target_path = workspace.join(target);
    let normalized = if target_path.exists() {
        target_path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {e}"))?
    } else {
        let mut resolved = workspace.clone();
        for component in Path::new(target).components() {
            match component {
                Component::ParentDir => {
                    resolved.pop();
                }
                Component::Normal(c) => {
                    resolved.push(c);
                }
                Component::CurDir => {}
                _ => return Err("Invalid path component".to_string()),
            }
        }
        resolved
    };

    if !normalized.starts_with(&workspace) {
        return Err(format!("Path outside workspace: {target}"));
    }

    Ok(normalized)
}

#[tauri::command]
pub fn tool_list_files(
    workspace: String,
    path: Option<String>,
    max_depth: Option<u32>,
) -> ToolResult {
    let rel = path.unwrap_or_else(|| ".".to_string());
    let max_depth = max_depth.unwrap_or(3);

    match normalize_path(&workspace, &rel) {
        Ok(abs) => {
            let mut entries = Vec::new();
            collect_entries(&workspace, &abs, &rel, &mut entries, 0, max_depth);
            ToolResult {
                success: true,
                result: Some(serde_json::json!({ "path": rel, "entries": entries })),
                error: None,
            }
        }
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

fn collect_entries(
    workspace: &str,
    abs: &Path,
    rel: &str,
    entries: &mut Vec<FileEntry>,
    depth: u32,
    max_depth: u32,
) {
    if depth > max_depth {
        return;
    }

    let Ok(read_dir) = fs::read_dir(abs) else {
        return;
    };

    let ignored = ["node_modules", ".git", "dist", "target", "build"];

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || ignored.contains(&name.as_str()) {
            continue;
        }

        let entry_rel = if rel == "." {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };

        let Ok(ft) = entry.file_type() else { continue };

        if ft.is_dir() {
            entries.push(FileEntry {
                name: name.clone(),
                path: entry_rel.clone(),
                entry_type: "directory".to_string(),
                size: None,
            });
            collect_entries(workspace, &entry.path(), &entry_rel, entries, depth + 1, max_depth);
        } else if ft.is_file() {
            let size = entry.metadata().ok().map(|m| m.len());
            entries.push(FileEntry {
                name,
                path: entry_rel,
                entry_type: "file".to_string(),
                size,
            });
        }
    }
}

#[tauri::command]
pub fn tool_read_file(
    workspace: String,
    path: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> ToolResult {
    match normalize_path(&workspace, &path) {
        Ok(abs) => match fs::read_to_string(&abs) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let offset = offset.unwrap_or(0) as usize;
                let limit = limit.unwrap_or(lines.len() as u32) as usize;
                let selected: Vec<&str> = lines
                    .iter()
                    .skip(offset)
                    .take(limit)
                    .copied()
                    .collect();
                let size = fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
                ToolResult {
                    success: true,
                    result: Some(serde_json::json!({
                        "path": path,
                        "content": selected.join("\n"),
                        "size": size,
                        "truncated": offset > 0 || selected.len() < lines.len()
                    })),
                    error: None,
                }
            }
            Err(e) => ToolResult {
                success: false,
                result: None,
                error: Some(e.to_string()),
            },
        },
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn tool_write_file(workspace: String, path: String, content: String) -> ToolResult {
    match normalize_path(&workspace, &path) {
        Ok(abs) => {
            let created = !abs.exists();
            if let Some(parent) = abs.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::write(&abs, &content) {
                Ok(()) => ToolResult {
                    success: true,
                    result: Some(serde_json::json!({
                        "path": path,
                        "bytesWritten": content.len(),
                        "created": created
                    })),
                    error: None,
                },
                Err(e) => ToolResult {
                    success: false,
                    result: None,
                    error: Some(e.to_string()),
                },
            }
        }
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn tool_create_file(workspace: String, path: String, content: String) -> ToolResult {
    match normalize_path(&workspace, &path) {
        Ok(abs) if abs.exists() => ToolResult {
            success: false,
            result: None,
            error: Some(format!("File already exists: {path}")),
        },
        Ok(_) => tool_write_file(workspace, path, content),
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn tool_delete_file(workspace: String, path: String) -> ToolResult {
    match normalize_path(&workspace, &path) {
        Ok(abs) => match fs::remove_file(&abs) {
            Ok(()) => ToolResult {
                success: true,
                result: Some(serde_json::json!({ "path": path, "deleted": true })),
                error: None,
            },
            Err(e) => ToolResult {
                success: false,
                result: None,
                error: Some(e.to_string()),
            },
        },
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn tool_replace_in_file(
    workspace: String,
    path: String,
    search: String,
    replace: String,
    replace_all: Option<bool>,
) -> ToolResult {
    let read = tool_read_file(workspace.clone(), path.clone(), None, None);
    if !read.success {
        return read;
    }

    let content = read
        .result
        .as_ref()
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    if !content.contains(&search) {
        return ToolResult {
            success: false,
            result: None,
            error: Some(format!("Search string not found in {path}")),
        };
    }

    let new_content = if replace_all.unwrap_or(false) {
        content.replace(&search, &replace)
    } else {
        content.replacen(&search, &replace, 1)
    };

    tool_write_file(workspace, path, new_content)
}

#[tauri::command]
pub fn tool_search_files(
    workspace: String,
    query: String,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
) -> ToolResult {
    let workspace_path = match PathBuf::from(&workspace).canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return ToolResult {
                success: false,
                result: None,
                error: Some(e.to_string()),
            }
        }
    };

    let mut matches = Vec::new();
    search_dir(
        &workspace_path,
        &workspace_path,
        &query,
        regex.unwrap_or(false),
        case_sensitive.unwrap_or(false),
        &mut matches,
        100,
    );

    ToolResult {
        success: true,
        result: Some(serde_json::json!({
            "query": query,
            "matches": matches,
            "totalMatches": matches.len(),
            "truncated": matches.len() >= 100
        })),
        error: None,
    }
}

fn search_dir(
    workspace: &Path,
    dir: &Path,
    query: &str,
    use_regex: bool,
    case_sensitive: bool,
    matches: &mut Vec<serde_json::Value>,
    max: usize,
) {
    if matches.len() >= max {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else { return };
    let ignored = ["node_modules", ".git", "dist", "target"];

    for entry in entries.flatten() {
        if matches.len() >= max {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || ignored.contains(&name.as_str()) {
            continue;
        }

        let path = entry.path();
        if path.is_dir() {
            search_dir(workspace, &path, query, use_regex, case_sensitive, matches, max);
        } else if path.is_file() {
            if let Ok(content) = fs::read_to_string(&path) {
                let rel = path
                    .strip_prefix(workspace)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();

                for (i, line) in content.lines().enumerate() {
                    let found = if use_regex {
                        regex::Regex::new(query)
                            .map(|re| re.is_match(line))
                            .unwrap_or(false)
                    } else if case_sensitive {
                        line.contains(query)
                    } else {
                        line.to_lowercase().contains(&query.to_lowercase())
                    };

                    if found {
                        matches.push(serde_json::json!({
                            "path": rel,
                            "line": i + 1,
                            "text": line.trim()
                        }));
                        if matches.len() >= max {
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn tool_run_command(workspace: String, command: String) -> ToolResult {
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", &command]).current_dir(&workspace).output()
    } else {
        Command::new("sh").args(["-c", &command]).current_dir(&workspace).output()
    };

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            ToolResult {
                success: true,
                result: Some(serde_json::json!({
                    "command": command,
                    "exitCode": out.status.code().unwrap_or(-1),
                    "stdout": stdout,
                    "stderr": stderr,
                    "timedOut": false
                })),
                error: None,
            }
        }
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn tool_get_git_diff(workspace: String, path: Option<String>) -> ToolResult {
    let mut cmd = Command::new("git");
    cmd.arg("diff").current_dir(&workspace);
    if let Some(p) = path {
        cmd.args(["--", &p]);
    }

    match cmd.output() {
        Ok(out) => {
            let diff = String::from_utf8_lossy(&out.stdout).to_string();
            ToolResult {
                success: true,
                result: Some(serde_json::json!({
                    "diff": diff,
                    "hasChanges": !diff.is_empty()
                })),
                error: None,
            }
        }
        Err(e) => ToolResult {
            success: false,
            result: None,
            error: Some(e.to_string()),
        },
    }
}

fn github_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("loopkit", "github-token").map_err(|e| e.to_string())
}

fn openrouter_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("loopkit", "openrouter-api-key").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn openrouter_get_key() -> ToolResult {
    match openrouter_entry() {
        Ok(entry) => match entry.get_password() {
            Ok(key) => ToolResult { success: true, result: Some(serde_json::json!({ "key": key })), error: None },
            Err(keyring::Error::NoEntry) => ToolResult { success: true, result: Some(serde_json::json!({ "key": null })), error: None },
            Err(error) => ToolResult { success: false, result: None, error: Some(error.to_string()) },
        },
        Err(error) => ToolResult { success: false, result: None, error: Some(error) },
    }
}

#[tauri::command]
pub fn openrouter_store_key(key: String) -> ToolResult {
    let result = if key.trim().is_empty() {
        openrouter_entry().and_then(|entry| entry.delete_credential().map_err(|error| error.to_string()))
    } else {
        openrouter_entry().and_then(|entry| entry.set_password(&key).map_err(|error| error.to_string()))
    };
    match result {
        Ok(()) => ToolResult { success: true, result: None, error: None },
        Err(error) => ToolResult { success: false, result: None, error: Some(error) },
    }
}

#[tauri::command]
pub fn github_client_id() -> String {
    std::env::var("GITHUB_CLIENT_ID").unwrap_or_else(|_| "Ov23liMo1oJoAzSI7573".to_string())
}

#[tauri::command]
pub fn github_get_token() -> ToolResult {
    match github_entry() {
        Ok(entry) => match entry.get_password() {
            Ok(token) => ToolResult { success: true, result: Some(serde_json::json!({ "token": token })), error: None },
            Err(keyring::Error::NoEntry) => ToolResult { success: true, result: Some(serde_json::json!({ "token": null })), error: None },
            Err(e) => ToolResult { success: false, result: None, error: Some(e.to_string()) },
        },
        Err(e) => ToolResult { success: false, result: None, error: Some(e) },
    }
}

#[tauri::command]
pub fn github_store_token(token: String) -> ToolResult {
    match github_entry().and_then(|entry| entry.set_password(&token).map_err(|e| e.to_string())) {
        Ok(()) => ToolResult { success: true, result: None, error: None },
        Err(e) => ToolResult { success: false, result: None, error: Some(e.to_string()) },
    }
}

#[tauri::command]
pub fn git_clone_repo(url: String, destination: String, name: String) -> ToolResult {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return ToolResult { success: false, result: None, error: Some("Invalid repository name".to_string()) };
    }
    if !(url.starts_with("https://") || url.starts_with("git@")) {
        return ToolResult { success: false, result: None, error: Some("Unsupported repository URL".to_string()) };
    }

    let destination = PathBuf::from(destination);
    if !destination.is_dir() {
        return ToolResult { success: false, result: None, error: Some("Destination must be an existing folder".to_string()) };
    }
    let target = destination.join(&name);
    if target.exists() {
        return ToolResult { success: false, result: None, error: Some(format!("Folder already exists: {}", target.display())) };
    }

    let token = match github_entry().and_then(|entry| entry.get_password().map_err(|e| e.to_string())) {
        Ok(token) => token,
        Err(e) => return ToolResult { success: false, result: None, error: Some(format!("GitHub authorization is required: {e}")) },
    };
    let askpass = std::env::temp_dir().join(format!("loopkit-git-askpass-{}", std::process::id()));
    let script = if cfg!(target_os = "windows") {
        let path = askpass.with_extension("cmd");
        std::fs::write(&path, "@echo off\nif /I \"%1\" == \"Username for 'https://github.com': \" (echo x-access-token) else (echo %LOOPKIT_GITHUB_TOKEN%)\n").ok();
        path
    } else {
        std::fs::write(&askpass, "#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token;; *) echo \"$LOOPKIT_GITHUB_TOKEN\";; esac\n").ok();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&askpass, fs::Permissions::from_mode(0o700));
        }
        askpass
    };
    let target_string = target.to_string_lossy().to_string();
    let output = Command::new("git")
        .args(["clone", &url, &target_string])
        .env("GIT_ASKPASS", &script)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LOOPKIT_GITHUB_TOKEN", token)
        .output();
    let _ = fs::remove_file(&script);
    match output {
        Ok(out) if out.status.success() => ToolResult {
            success: true,
            result: Some(serde_json::json!({ "path": target })),
            error: None,
        },
        Ok(out) => ToolResult {
            success: false,
            result: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        },
        Err(e) => ToolResult { success: false, result: None, error: Some(e.to_string()) },
    }
}

fn worktree_root(repository: &Path) -> PathBuf {
    repository
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".loopkit-worktrees")
        .join(repository.file_name().unwrap_or_default())
}

fn valid_git_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'))
        && !value.contains("..")
}

#[tauri::command]
pub fn git_worktree_create(repository: String, branch: String, session_id: String) -> ToolResult {
    let repository = match PathBuf::from(&repository).canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => return ToolResult { success: false, result: None, error: Some("Repository does not exist".to_string()) },
    };
    if !valid_git_identifier(&branch) || !valid_git_identifier(&session_id) || session_id.contains('/') {
        return ToolResult { success: false, result: None, error: Some("Invalid branch or session identifier".to_string()) };
    }
    let target = worktree_root(&repository).join(&session_id);
    if target.exists() {
        return ToolResult { success: false, result: None, error: Some(format!("Worktree already exists: {}", target.display())) };
    }
    if let Err(error) = fs::create_dir_all(target.parent().unwrap_or(Path::new("."))) {
        return ToolResult { success: false, result: None, error: Some(error.to_string()) };
    }
    let output = Command::new("git")
        .args(["-C", &repository.to_string_lossy(), "worktree", "add", "-b", &branch, &target.to_string_lossy(), "HEAD"])
        .output();
    match output {
        Ok(out) if out.status.success() => ToolResult {
            success: true,
            result: Some(serde_json::json!({ "path": target, "branch": branch })),
            error: None,
        },
        Ok(out) => ToolResult { success: false, result: None, error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()) },
        Err(error) => ToolResult { success: false, result: None, error: Some(error.to_string()) },
    }
}

#[tauri::command]
pub fn git_worktree_remove(repository: String, worktree: String) -> ToolResult {
    let repository = match PathBuf::from(&repository).canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => return ToolResult { success: false, result: None, error: Some("Repository does not exist".to_string()) },
    };
    let worktree = PathBuf::from(&worktree);
    let expected_root = worktree_root(&repository);
    if !worktree.starts_with(&expected_root) || worktree == repository {
        return ToolResult { success: false, result: None, error: Some("Invalid worktree path".to_string()) };
    }
    let output = Command::new("git")
        .args(["-C", &repository.to_string_lossy(), "worktree", "remove", "--force", &worktree.to_string_lossy()])
        .output();
    match output {
        Ok(out) if out.status.success() => ToolResult { success: true, result: Some(serde_json::json!({ "removed": true })), error: None },
        Ok(out) => ToolResult { success: false, result: None, error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()) },
        Err(error) => ToolResult { success: false, result: None, error: Some(error.to_string()) },
    }
}

fn git_command(workspace: &str, args: &[&str]) -> Result<String, String> {
    let root = PathBuf::from(workspace).canonicalize().map_err(|_| "Workspace does not exist".to_string())?;
    let output = Command::new("git").arg("-C").arg(root).args(args).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn github_repo_from_remote(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches(".git");
    remote.strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("http://github.com/"))
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .filter(|repo| repo.split('/').count() == 2)
        .map(String::from)
}

#[tauri::command]
pub fn git_handoff_status(workspace: String) -> ToolResult {
    let branch = match git_command(&workspace, &["rev-parse", "--abbrev-ref", "HEAD"]) { Ok(value) => value, Err(error) => return ToolResult { success: false, result: None, error: Some(error) } };
    let changed = match git_command(&workspace, &["status", "--porcelain"]) { Ok(value) => !value.is_empty(), Err(error) => return ToolResult { success: false, result: None, error: Some(error) } };
    let remote = git_command(&workspace, &["remote", "get-url", "origin"]).ok();
    let base = git_command(&workspace, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .and_then(|value| value.strip_prefix("origin/").map(String::from))
        .unwrap_or_else(|| "main".to_string());
    ToolResult { success: true, result: Some(serde_json::json!({ "branch": branch, "changed": changed, "remote": remote, "githubRepo": remote.as_deref().and_then(github_repo_from_remote), "base": base })), error: None }
}

#[tauri::command]
pub fn git_commit_changes(workspace: String, message: String) -> ToolResult {
    let message = message.trim();
    if message.is_empty() || message.len() > 500 { return ToolResult { success: false, result: None, error: Some("Commit message must be between 1 and 500 characters".to_string()) }; }
    if let Err(error) = git_command(&workspace, &["add", "-A"]) { return ToolResult { success: false, result: None, error: Some(error) }; }
    let staged = match git_command(&workspace, &["diff", "--cached", "--quiet"]) { Ok(_) => false, Err(_) => true };
    if !staged { return ToolResult { success: false, result: None, error: Some("There are no changes to commit".to_string()) }; }
    match git_command(&workspace, &["commit", "-m", message]) {
        Ok(_) => ToolResult { success: true, result: Some(serde_json::json!({ "committed": true })), error: None },
        Err(error) => ToolResult { success: false, result: None, error: Some(error) },
    }
}

#[tauri::command]
pub fn git_push_branch(workspace: String) -> ToolResult {
    let branch = match git_command(&workspace, &["rev-parse", "--abbrev-ref", "HEAD"]) { Ok(value) => value, Err(error) => return ToolResult { success: false, result: None, error: Some(error) } };
    let remote = match git_command(&workspace, &["remote", "get-url", "origin"]) { Ok(value) => value, Err(error) => return ToolResult { success: false, result: None, error: Some(error) } };
    let root = match PathBuf::from(&workspace).canonicalize() { Ok(path) => path, Err(_) => return ToolResult { success: false, result: None, error: Some("Workspace does not exist".to_string()) } };
    let token = github_entry().and_then(|entry| entry.get_password().map_err(|e| e.to_string())).ok();
    let askpass = std::env::temp_dir().join(format!("loopkit-git-push-{}", std::process::id()));
    if let Some(token) = token.as_ref() {
        let _ = std::fs::write(&askpass, "#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token;; *) echo \"$LOOPKIT_GITHUB_TOKEN\";; esac\n");
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(&askpass, fs::Permissions::from_mode(0o700)); }
        let output = Command::new("git").args(["-C", &root.to_string_lossy(), "push", "-u", "origin", &branch]).env("GIT_ASKPASS", &askpass).env("GIT_TERMINAL_PROMPT", "0").env("LOOPKIT_GITHUB_TOKEN", token).output();
        let _ = fs::remove_file(&askpass);
        match output {
            Ok(out) if out.status.success() => {},
            Ok(out) => return ToolResult { success: false, result: None, error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()) },
            Err(error) => return ToolResult { success: false, result: None, error: Some(error.to_string()) },
        }
    } else if let Err(error) = git_command(&workspace, &["push", "-u", "origin", &branch]) { return ToolResult { success: false, result: None, error: Some(error) }; }
    let base = git_command(&workspace, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).ok().and_then(|value| value.strip_prefix("origin/").map(String::from)).unwrap_or_else(|| "main".to_string());
    let pull_request_url = github_repo_from_remote(&remote).map(|repo| format!("https://github.com/{repo}/compare/{base}...{branch}?expand=1"));
    ToolResult { success: true, result: Some(serde_json::json!({ "branch": branch, "pullRequestUrl": pull_request_url })), error: None }
}

#[tauri::command]
pub fn tool_execute(
    workspace: String,
    name: String,
    args: serde_json::Value,
    mode: String,
) -> ToolResult {
    let goal_only = ["write_file", "replace_in_file", "create_file", "delete_file", "run_command", "get_git_diff"];
    if mode == "ask" && goal_only.contains(&name.as_str()) {
        return ToolResult {
            success: false,
            result: None,
            error: Some(format!("{name} is not available in Ask mode")),
        };
    }

    match name.as_str() {
        "list_files" => tool_list_files(
            workspace,
            args.get("path").and_then(|v| v.as_str()).map(String::from),
            args.get("max_depth").and_then(|v| v.as_u64()).map(|v| v as u32),
        ),
        "read_file" => tool_read_file(
            workspace,
            args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            args.get("offset").and_then(|v| v.as_u64()).map(|v| v as u32),
            args.get("limit").and_then(|v| v.as_u64()).map(|v| v as u32),
        ),
        "write_file" => tool_write_file(
            workspace,
            args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ),
        "create_file" => tool_create_file(
            workspace,
            args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ),
        "delete_file" => tool_delete_file(
            workspace,
            args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ),
        "replace_in_file" => tool_replace_in_file(
            workspace,
            args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            args.get("search").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            args.get("replace").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            args.get("replace_all").and_then(|v| v.as_bool()),
        ),
        "search_files" => tool_search_files(
            workspace,
            args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            args.get("regex").and_then(|v| v.as_bool()),
            args.get("case_sensitive").and_then(|v| v.as_bool()),
        ),
        "run_command" => tool_run_command(
            workspace,
            args.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ),
        "get_git_diff" => tool_get_git_diff(
            workspace,
            args.get("path").and_then(|v| v.as_str()).map(String::from),
        ),
        _ => ToolResult {
            success: false,
            result: None,
            error: Some(format!("Unknown tool: {name}")),
        },
    }
}
