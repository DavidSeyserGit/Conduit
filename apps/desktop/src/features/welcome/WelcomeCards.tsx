import type { ReactNode } from "react";

interface FeatureCard {
  icon: ReactNode;
  label: string;
  color: string;
  iconBg: string;
}

function CodeIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>
  );
}

function AvatarIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/>
      <path d="M20 21a8 8 0 10-16 0"/>
    </svg>
  );
}

function DocIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>
  );
}

const cards: FeatureCard[] = [
  {
    icon: <CodeIcon />,
    label: "Write code",
    iconBg: "bg-orange-50",
    color: "text-orange-500",
  },
  {
    icon: <ImageIcon />,
    label: "Image generation",
    iconBg: "bg-slate-700",
    color: "text-white",
  },
  {
    icon: <AvatarIcon />,
    label: "Create avatar",
    iconBg: "bg-emerald-100",
    color: "text-emerald-600",
  },
  {
    icon: <DocIcon />,
    label: "Write document",
    iconBg: "bg-indigo-100",
    color: "text-indigo-600",
  },
];

export function WelcomeCards() {
  return (
    <div className="grid grid-cols-2 gap-3 max-w-md mx-auto w-full px-4">
      {cards.map((card) => (
        <button
          key={card.label}
          className={`flex items-center gap-3 p-3.5 rounded-2xl border border-gray-200 bg-white hover:shadow-md hover:border-gray-300 transition-all group text-left`}
        >
          <div className={`${card.iconBg} w-10 h-10 rounded-xl flex items-center justify-center ${card.color} shrink-0`}>
            {card.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 truncate">{card.label}</div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 group-hover:text-gray-600 transition-colors shrink-0">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      ))}
    </div>
  );
}
