import { useState, useEffect } from 'react';
import { CoachChat } from '@/components/CoachChat';
import { TodayTab } from '@/components/TodayTab';
import { NutritionTab } from '@/components/NutritionTab';
import { CalendarTab } from '@/components/CalendarTab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useMediaQuery } from '@/lib/use-media-query';
import { getJson } from '@/lib/api';

interface Suggestion {
  prompt: string;
}

const DESKTOP_QUERY = '(min-width: 1024px)';

function App() {
  const [activeTab, setActiveTab] = useState('today');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [athleteName, setAthleteName] = useState('');
  // Below lg, the persistent side-by-side layout doesn't fit — chat becomes
  // a 4th tab instead of a permanent column. CoachChat must be mounted in
  // exactly one of those two places at a time (never both: CSS visibility
  // classes alone would leave two live chat runtimes/history loads in the
  // DOM simultaneously), hence tracking this in JS rather than pure CSS.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  useEffect(() => {
    // Suggestions are a nicety on an otherwise usable screen, so a failure just
    // means none are offered.
    getJson<{ suggestions: Suggestion[] }>('/api/chat/suggestions')
      .then((data) => setSuggestions(data.suggestions ?? []))
      .catch(() => setSuggestions([]));
  }, []);

  // If the viewport grows past the breakpoint while "Chat" (mobile-only) is
  // selected, that tab disappears from the list — fall back to a real one.
  useEffect(() => {
    if (isDesktop && activeTab === 'chat') setActiveTab('today');
  }, [isDesktop, activeTab]);

  const firstName = athleteName.split(' ')[0] || 'Coach';
  const chat = <CoachChat firstName={firstName} suggestions={suggestions} />;

  return (
    <div className="h-dvh w-screen overflow-hidden bg-background text-foreground flex justify-center">
    <div className="w-full max-w-[1600px] h-full flex flex-col lg:flex-row overflow-hidden">
      {/* Left column: Today / Nutrition / History (+ Chat tab below lg) */}
      <div className="w-full lg:w-1/2 shrink-0 h-full flex flex-col min-h-0">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full min-h-0 gap-0">
          <div className="px-5 pt-4 pb-2 shrink-0">
            <TabsList>
              <TabsTrigger value="today">Today</TabsTrigger>
              <TabsTrigger value="nutrition">Nutrition</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
              {!isDesktop && <TabsTrigger value="chat">Chat</TabsTrigger>}
            </TabsList>
          </div>
          <TabsContent value="today" forceMount className="overflow-y-auto data-[state=inactive]:hidden">
            <TodayTab onViewCalendar={() => setActiveTab('history')} onProfileName={setAthleteName} />
          </TabsContent>
          <TabsContent value="nutrition" forceMount className="overflow-y-auto data-[state=inactive]:hidden">
            <NutritionTab />
          </TabsContent>
          <TabsContent value="history" forceMount className="overflow-hidden data-[state=inactive]:hidden">
            <CalendarTab />
          </TabsContent>
          {!isDesktop && (
            <TabsContent
              value="chat"
              forceMount
              className="overflow-hidden data-[state=inactive]:hidden flex flex-col min-h-0 [&>div]:flex-1 [&>div]:min-h-0 [&>div]:h-full"
            >
              {chat}
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Right column: persistent Coach chat — lg and above only */}
      {isDesktop && (
        <div className="w-1/2 shrink-0 h-full p-3 bg-background">
          <div className="h-full overflow-hidden bg-card flex flex-col [&>div]:flex-1 [&>div]:min-h-0 [&>div]:h-full">
            {chat}
          </div>
        </div>
      )}
    </div>
    </div>
  );
}

export default App;
