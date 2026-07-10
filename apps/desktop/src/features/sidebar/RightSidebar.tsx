import type { ReactNode } from "react";
import { useAppStore } from "@/stores/app-store";

interface ProjectItem {
  id: string;
  title: string;
  description: string;
  icon: ReactNode;
}

const projectItems: ProjectItem[] = [
  {
    id: "1",
    title: "Create Your First Project",
    description: "Get started with LoopKit by...",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gray-400">
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm.5 4V3h-1v2H5v1h2v2h1V6h2V5H8.5z"/>
      </svg>
    ),
  },
  {
    id: "2",
    title: "Learn Next 100 Topics",
    description: "Build a learning tracker with...",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-blue-500">
        <path d="M2 2h4v4H2V2zm0 6h4v6H2V8zm8-6h4v4h-4V2zm0 6h4v6h-4V8z"/>
      </svg>
    ),
  },
  {
    id: "3",
    title: "Research AI Agents",
    description: "Investigate best practices...",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-orange-400">
        <path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 11a5 5 0 110-10 5 5 0 010 10zm1-6H4.5V5.5H8v3l2.5 1.5-.5.83-2.5-1.5z"/>
      </svg>
    ),
  },
];

interface SuggestionItem {
  id: string;
  text: string;
}

const suggestionItems: SuggestionItem[] = [
  { id: "s1", text: "What do you know about AI coding..." },
  { id: "s2", text: "Write a story about a robot..." },
  { id: "s3", text: "What are some best ways to learn..." },
  { id: "s4", text: "Tell me about climate change..." },
  { id: "s5", text: "Write a short story..." },
  { id: "s6", text: "Plan a trip to Japan..." },
  { id: "s7", text: "Read article and summarize..." },
];

export function RightSidebar() {
  const setInputText = useAppStore((s) => s.setInputText);

  const handleSuggestionClick = (text: string) => {
    setInputText?.(text);
  };

  return (
    <aside className="w-[280px] flex flex-col bg-white border-l border-gray-200 shrink-0">
      <div className="px-4 py-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Projects</h3>
        <button className="text-xs text-gray-500 hover:text-gray-900 transition-colors">
          New Project
        </button>
      </div>

      <div className="px-3 space-y-1 overflow-y-auto flex-1">
        {projectItems.map((project) => (
          <button
            key={project.id}
            className="w-full text-left p-2.5 rounded-lg hover:bg-gray-50 transition-colors flex items-start gap-2.5"
          >
            <span className="mt-0.5 shrink-0">{project.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate leading-tight">
                {project.title}
              </div>
              <div className="text-xs text-gray-500 mt-0.5 truncate leading-tight">
                {project.description}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="px-4 pt-3 pb-2 border-t border-gray-100 mt-2">
        <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">Read</span>
      </div>

      <div className="px-3 pb-3 space-y-0.5 overflow-y-auto">
        {suggestionItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleSuggestionClick(item.text)}
            className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors truncate"
          >
            {item.text}
          </button>
        ))}
      </div>
    </aside>
  );
}
