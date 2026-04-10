import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LoopMode, Sermon } from "@/types";
import { SERMONS } from "@/data/sermons";

interface PlayerContextType {
  currentSermon: Sermon | null;
  nextSermon: Sermon | null;
  isPlaying: boolean;
  isRadioMode: boolean;
  isLive: boolean;
  queue: Sermon[];
  currentIndex: number;
  dataSaver: boolean;
  shuffleMode: boolean;
  loopMode: LoopMode;
  playSermon: (sermon: Sermon, newQueue?: Sermon[]) => void;
  playLive: () => void;
  togglePlay: () => void;
  toggleRadioMode: () => void;
  toggleDataSaver: () => void;
  toggleShuffle: () => void;
  cycleLoopMode: () => void;
  playNext: () => void;
  playPrevious: () => void;
  advanceToNext: () => void;
  setQueue: (sermons: Sermon[]) => void;
  stopPlayback: () => void;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

const LOOP_CYCLE: LoopMode[] = ["none", "all", "one"];

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function buildShuffledQueue(sermons: Sermon[], startId?: string): Sermon[] {
  const shuffled = fisherYatesShuffle(sermons);
  if (startId) {
    const idx = shuffled.findIndex((s) => s.youtubeId === startId);
    if (idx > 0) {
      const [item] = shuffled.splice(idx, 1);
      if (item) shuffled.unshift(item);
    }
  }
  return shuffled;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [currentSermon, setCurrentSermon] = useState<Sermon | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRadioMode, setIsRadioMode] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [queue, setQueueState] = useState<Sermon[]>(SERMONS);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [dataSaver, setDataSaver] = useState(false);
  const [shuffleMode, setShuffleMode] = useState(false);
  const [loopMode, setLoopMode] = useState<LoopMode>("all");
  const [shuffledQueue, setShuffledQueue] = useState<Sermon[]>(() =>
    buildShuffledQueue(SERMONS),
  );
  const [shufflePosition, setShufflePosition] = useState(0);

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const shuffleRef = useRef(shuffleMode);
  shuffleRef.current = shuffleMode;
  const loopRef = useRef(loopMode);
  loopRef.current = loopMode;
  const shuffledQueueRef = useRef(shuffledQueue);
  shuffledQueueRef.current = shuffledQueue;
  const shufflePosRef = useRef(shufflePosition);
  shufflePosRef.current = shufflePosition;
  const currentSermonRef = useRef(currentSermon);
  currentSermonRef.current = currentSermon;

  useEffect(() => {
    const rebuilt = buildShuffledQueue(queue, currentSermon?.youtubeId);
    setShuffledQueue(rebuilt);
    const pos = rebuilt.findIndex((s) => s.youtubeId === currentSermon?.youtubeId);
    setShufflePosition(pos >= 0 ? pos : 0);
  }, [shuffleMode]);

  useEffect(() => {
    if (shuffleMode) {
      const rebuilt = buildShuffledQueue(queue, currentSermon?.youtubeId);
      setShuffledQueue(rebuilt);
      const pos = rebuilt.findIndex((s) => s.youtubeId === currentSermon?.youtubeId);
      setShufflePosition(pos >= 0 ? pos : 0);
    }
  }, [queue]);

  const nextSermon = useMemo((): Sermon | null => {
    if (isLive || !currentSermon) return null;
    if (loopMode === "one") return currentSermon;

    if (shuffleMode) {
      const sq = shuffledQueue;
      const pos = shufflePosition;
      const nextPos = pos + 1;
      if (nextPos >= sq.length) {
        return loopMode === "none" ? null : (sq[0] ?? null);
      }
      return sq[nextPos] ?? null;
    } else {
      const nextIdx = currentIndex + 1;
      if (nextIdx >= queue.length) {
        return loopMode === "none" ? null : (queue[0] ?? null);
      }
      return queue[nextIdx] ?? null;
    }
  }, [
    currentSermon,
    currentIndex,
    shuffleMode,
    shufflePosition,
    shuffledQueue,
    queue,
    loopMode,
    isLive,
  ]);

  const playSermon = useCallback((sermon: Sermon, newQueue?: Sermon[]) => {
    const q = newQueue ?? queueRef.current;
    if (newQueue) {
      setQueueState(newQueue);
      queueRef.current = newQueue;
    }

    setCurrentSermon(sermon);
    setIsPlaying(true);
    setIsLive(false);

    const idx = q.findIndex((s) => s.id === sermon.id);
    if (idx >= 0) setCurrentIndex(idx);

    if (shuffleRef.current) {
      const sq = buildShuffledQueue(q, sermon.youtubeId);
      setShuffledQueue(sq);
      setShufflePosition(0);
    }
  }, []);

  const playLive = useCallback(() => {
    setIsLive(true);
    setIsPlaying(true);
    setCurrentSermon(null);
  }, []);

  const togglePlay = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  const toggleRadioMode = useCallback(() => {
    setIsRadioMode((prev) => !prev);
  }, []);

  const toggleDataSaver = useCallback(() => {
    setDataSaver((prev) => !prev);
  }, []);

  const toggleShuffle = useCallback(() => {
    setShuffleMode((prev) => {
      const next = !prev;
      if (next) {
        const rebuilt = buildShuffledQueue(queueRef.current, currentSermonRef.current?.youtubeId);
        setShuffledQueue(rebuilt);
        setShufflePosition(0);
      }
      return next;
    });
  }, []);

  const cycleLoopMode = useCallback(() => {
    setLoopMode((prev) => {
      const idx = LOOP_CYCLE.indexOf(prev);
      return LOOP_CYCLE[(idx + 1) % LOOP_CYCLE.length]!;
    });
  }, []);

  const playNext = useCallback(() => {
    const loop = loopRef.current;
    const shuffle = shuffleRef.current;

    if (loop === "one") {
      setIsPlaying(false);
      requestAnimationFrame(() => setIsPlaying(true));
      return;
    }

    setIsLive(false);

    if (shuffle) {
      const sq = shuffledQueueRef.current;
      const nextPos = shufflePosRef.current + 1;
      if (nextPos >= sq.length) {
        if (loop === "none") {
          setIsPlaying(false);
          return;
        }
        const rebuiltQueue = buildShuffledQueue(queueRef.current);
        setShuffledQueue(rebuiltQueue);
        shuffledQueueRef.current = rebuiltQueue;
        setShufflePosition(0);
        const first = rebuiltQueue[0] ?? null;
        setCurrentSermon(first);
        if (first) {
          const qi = queueRef.current.findIndex((s) => s.id === first.id);
          if (qi >= 0) setCurrentIndex(qi);
        }
      } else {
        setShufflePosition(nextPos);
        const next = sq[nextPos] ?? null;
        setCurrentSermon(next);
        if (next) {
          const qi = queueRef.current.findIndex((s) => s.id === next.id);
          if (qi >= 0) setCurrentIndex(qi);
        }
      }
    } else {
      const q = queueRef.current;
      const nextIdx = currentIndexRef.current + 1;
      if (nextIdx >= q.length) {
        if (loop === "none") {
          setIsPlaying(false);
          return;
        }
        setCurrentIndex(0);
        setCurrentSermon(q[0] ?? null);
      } else {
        setCurrentIndex(nextIdx);
        setCurrentSermon(q[nextIdx] ?? null);
      }
    }

    setIsPlaying(true);
  }, []);

  const advanceToNext = useCallback(() => {
    playNext();
  }, [playNext]);

  const playPrevious = useCallback(() => {
    const loop = loopRef.current;
    const shuffle = shuffleRef.current;
    setIsLive(false);

    if (shuffle) {
      const prevPos = Math.max(0, shufflePosRef.current - 1);
      setShufflePosition(prevPos);
      const prev = shuffledQueueRef.current[prevPos] ?? null;
      setCurrentSermon(prev);
      if (prev) {
        const qi = queueRef.current.findIndex((s) => s.id === prev.id);
        if (qi >= 0) setCurrentIndex(qi);
      }
    } else {
      const q = queueRef.current;
      const idx = currentIndexRef.current;
      const prevIdx = idx === 0 ? (loop === "none" ? 0 : q.length - 1) : idx - 1;
      setCurrentIndex(prevIdx);
      setCurrentSermon(q[prevIdx] ?? null);
    }

    setIsPlaying(true);
  }, []);

  const setQueue = useCallback((sermons: Sermon[]) => {
    setQueueState(sermons);
    if (shuffleRef.current) {
      const rebuilt = buildShuffledQueue(sermons, currentSermonRef.current?.youtubeId);
      setShuffledQueue(rebuilt);
      setShufflePosition(0);
    }
  }, []);

  const stopPlayback = useCallback(() => {
    setIsPlaying(false);
    setCurrentSermon(null);
    setIsLive(false);
  }, []);

  const value = useMemo(
    () => ({
      currentSermon,
      nextSermon,
      isPlaying,
      isRadioMode,
      isLive,
      queue,
      currentIndex,
      dataSaver,
      shuffleMode,
      loopMode,
      playSermon,
      playLive,
      togglePlay,
      toggleRadioMode,
      toggleDataSaver,
      toggleShuffle,
      cycleLoopMode,
      playNext,
      playPrevious,
      advanceToNext,
      setQueue,
      stopPlayback,
    }),
    [
      currentSermon,
      nextSermon,
      isPlaying,
      isRadioMode,
      isLive,
      queue,
      currentIndex,
      dataSaver,
      shuffleMode,
      loopMode,
      playSermon,
      playLive,
      togglePlay,
      toggleRadioMode,
      toggleDataSaver,
      toggleShuffle,
      cycleLoopMode,
      playNext,
      playPrevious,
      advanceToNext,
      setQueue,
      stopPlayback,
    ],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer() {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
}
