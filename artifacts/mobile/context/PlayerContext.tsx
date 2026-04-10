import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { LoopMode, Sermon } from "@/types";
import { SERMONS } from "@/data/sermons";

interface PlayerContextType {
  currentSermon: Sermon | null;
  isPlaying: boolean;
  isRadioMode: boolean;
  isLive: boolean;
  queue: Sermon[];
  currentIndex: number;
  dataSaver: boolean;
  shuffleMode: boolean;
  loopMode: LoopMode;
  playSermon: (sermon: Sermon) => void;
  playLive: () => void;
  togglePlay: () => void;
  toggleRadioMode: () => void;
  toggleDataSaver: () => void;
  toggleShuffle: () => void;
  cycleLoopMode: () => void;
  playNext: () => void;
  playPrevious: () => void;
  setQueue: (sermons: Sermon[]) => void;
  stopPlayback: () => void;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

const LOOP_CYCLE: LoopMode[] = ["none", "all", "one"];

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

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const shuffleRef = useRef(shuffleMode);
  shuffleRef.current = shuffleMode;
  const loopRef = useRef(loopMode);
  loopRef.current = loopMode;

  const playSermon = useCallback((sermon: Sermon) => {
    setCurrentSermon(sermon);
    setIsPlaying(true);
    setIsLive(false);
    const idx = queueRef.current.findIndex((s) => s.id === sermon.id);
    if (idx >= 0) setCurrentIndex(idx);
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
    setShuffleMode((prev) => !prev);
  }, []);

  const cycleLoopMode = useCallback(() => {
    setLoopMode((prev) => {
      const idx = LOOP_CYCLE.indexOf(prev);
      return LOOP_CYCLE[(idx + 1) % LOOP_CYCLE.length];
    });
  }, []);

  const playNext = useCallback(() => {
    const q = queueRef.current;
    const idx = currentIndexRef.current;
    const loop = loopRef.current;
    const shuffle = shuffleRef.current;

    if (loop === "one") {
      setIsPlaying(false);
      setTimeout(() => setIsPlaying(true), 100);
      return;
    }

    if (shuffle) {
      const pool = q.filter((_, i) => i !== idx);
      if (pool.length === 0) {
        if (loop === "none") {
          setIsPlaying(false);
          return;
        }
        const randIdx = Math.floor(Math.random() * q.length);
        setCurrentIndex(randIdx);
        setCurrentSermon(q[randIdx]);
      } else {
        const rand = Math.floor(Math.random() * pool.length);
        const next = pool[rand];
        const nextIdx = q.findIndex((s) => s.id === next.id);
        setCurrentIndex(nextIdx);
        setCurrentSermon(next);
      }
    } else {
      const nextIdx = idx + 1;
      if (nextIdx >= q.length) {
        if (loop === "none") {
          setIsPlaying(false);
          return;
        }
        setCurrentIndex(0);
        setCurrentSermon(q[0]);
      } else {
        setCurrentIndex(nextIdx);
        setCurrentSermon(q[nextIdx]);
      }
    }

    setIsPlaying(true);
    setIsLive(false);
  }, []);

  const playPrevious = useCallback(() => {
    const q = queueRef.current;
    const idx = currentIndexRef.current;
    const prevIdx = idx === 0 ? q.length - 1 : idx - 1;
    setCurrentIndex(prevIdx);
    setCurrentSermon(q[prevIdx]);
    setIsPlaying(true);
    setIsLive(false);
  }, []);

  const setQueue = useCallback((sermons: Sermon[]) => {
    setQueueState(sermons);
  }, []);

  const stopPlayback = useCallback(() => {
    setIsPlaying(false);
    setCurrentSermon(null);
    setIsLive(false);
  }, []);

  const value = useMemo(
    () => ({
      currentSermon,
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
      setQueue,
      stopPlayback,
    }),
    [
      currentSermon,
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
