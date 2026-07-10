import { useState } from "react";
import type { ReactNode } from "react";
import { useAppStore } from "@/stores/app-store";

interface NavItem {
  icon: ReactNode;
  label: string;
  badge?: string;
  active?: boolean;
  onClick?: () => void;
}

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.5C2 1.67 2.67 1 3.5 1h9c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5h-2.2l-2.3 2.3c-.3.3-.8.3-1.1 0L4.7 11H3.5C2.67 11 2 10.33 2 9.5v-7z"/></svg>
  );
}

function ProjectsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2.5A1.5 1.5 0 003 4h3v2h6.5A1.5 1.5 0 0114 7.5v4.5A1.5 1.5 0 0112.5 13.5h-9A1.5 1.5 0 012 12V4a1 1 0 00-.5 0v8a2.5 2.5 0 002 2.5h9A2.5 2.5 0 0015 12V7.5A2.5 2.5 0 0012.5 5H6V2.5A1.5 1.5 0 003 4h3V2.5H3A1.5 1.5 0 001.5 2.5z"/></svg>
  );
}

function TemplatesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h4v4H2V2zm0 6h4v6H2V8zm8-6h4v4h-4V2zm0 6h4v6h-4V8z"/></svg>
  );
}

function DocumentsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V6l-4-5zm0 1.4L12.6 6H10V2.4zM5 3h4v3h3v7H5V3zm1 5h4v1H6V8zm0 2h4v1H6v-1z"/></svg>
  );
}

function CommunityIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8a2 2 0 110-4 2 2 0 010 4zm0 1c-3 0-4.5 1.5-4.5 4v1h9v-1c0-2.5-1.5-4-4.5-4zm5-6.5a1 1 0 00-1-1h-1.5a3.5 3.5 0 01.47 1 6 6 0 01.53 0 2 2 0 012 2v2a3.5 3.5 0 011-.47V2.5zM4.5 2H3a1 1 0 00-1 1v.5a3.5 3.5 0 011 .47V4a2 2 0 012-2h.03a3.5 3.5 0 01.47-1z"/></svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 11a5 5 0 110-10 5 5 0 010 10zm1-6H4.5V5.5H8v3l2.5 1.5-.5.83-2.5-1.5z"/></svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 10a2 2 0 100-4 2 2 0 000 4zm0 1a1 1 0 00-1-1H5.41l-.29-1.71L6.29 7.2l-.71-.7-1.42 1.08L2.58 7.1 2 8.27l1.58.42.28 1.72-1.1 1.08 1.42.82.52-1.31h1.3l.52 1.31 1.42-.82-1.1-1.08.52-1.72h-.7zm7 0a1 1 0 01-1 1h-1.58l-.52 1.31-1.42-.82 1.1-1.08-.28-1.72-1.58-.42.58-1.17 1.42-1.08.71.7-1.17 1.09.29 1.71H14a1 1 0 010 2zm-8-9a1 1 0 011-1h2a1 1 0 110 2H8a1 1 0 01-1-1z"/></svg>
  );
}

function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM2 8a6 6 0 1112 0A6 6 0 012 8zm5.7-2.3A1.7 1.7 0 019 4.7a1.7 1.7 0 010 3.4l-.7.7V10h-.7V8.3L8.6 7A1 1 0 008 5.3a1 1 0 00-.3.7H7a1.7 1.7 0 01.7-1.3zM7.3 11H8v1.3h-.7V11z"/></svg>
  );
}

const navItems: NavItem[] = [
  { icon: <ChatIcon />, label: "Chat", active: true },
  { icon: <ProjectsIcon />, label: "Projects" },
  { icon: <TemplatesIcon />, label: "Templates" },
  { icon: <DocumentsIcon />, label: "Documents" },
  { icon: <CommunityIcon />, label: "Community", badge: "new" },
  { icon: <HistoryIcon />, label: "History" },
  { icon: <SettingsIcon />, label: "Settings & Help" },
  { icon: <HelpIcon />, label: "Help" },
];

export function LeftSidebar() {
  const [activeItem, setActiveItem] = useState("Chat");
  const [searchValue, setSearchValue] = useState("");
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  const handleNavClick = (item: string) => {
    setActiveItem(item);
    if (item === "Settings & Help") {
      setShowSettings(true);
    }
  };

  return (
    <aside className="w-[220px] flex flex-col bg-white border-r border-gray-200 shrink-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="w-8 h-8 bg-gray-950 rounded-full flex items-center justify-center text-white font-semibold text-sm">
          L
        </div>
        <span className="font-semibold text-gray-900">LoopKit</span>
      </div>

      <div className="px-3 mb-2">
        <div className="flex items-center px-3 py-1.5 bg-gray-100 rounded-full text-xs text-gray-500">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="mr-1.5 shrink-0">
            <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M8 8l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            className="flex-1 bg-transparent outline-none text-xs placeholder-gray-500"
          />
          <span className="text-xs text-gray-400 ml-1 shrink-0 font-mono">⌘K</span>
        </div>
      </div>

      <nav className="flex-1 px-2 py-1 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => (
          <button
            key={item.label}
            onClick={() => handleNavClick(item.label)}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors relative ${
              activeItem === item.label
                ? "text-gray-900 bg-gray-100"
                : item.label === "Community"
                ? "text-gray-700 hover:bg-gray-50"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            <span className={activeItem === item.label ? "text-gray-900" : "text-gray-500"}>
              {item.icon}
            </span>
            <span>{item.label}</span>
            {item.badge === "new" && (
              <span className="ml-auto text-xs bg-blue-600 text-white px-1.5 py-0.5 rounded-full font-medium leading-none">
                New
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="p-3 border-t border-gray-200">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-xs font-semibold text-white shrink-0">
            R
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 truncate">Robby Gorillo</div>
            <div className="text-xs text-gray-500 truncate">Free tier · 286 queries</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
