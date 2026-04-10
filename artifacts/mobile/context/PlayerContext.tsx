import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { Sermon } from "@/types";
import { SERMONS } from "@/data/sermons";

interface PlayerContextType {
  currentSermon: Sermon | null;
  isPlaying: boolean;
  isRadioMode: boolean;
  isLive: boolean;
  queue: Sermon[];
  currentIndex: number;
  dataSaver: boolean;
  playSermon: (sermon: Sermon) => void;
  playLive: () => void;
  togglePlay: () => void;
  toggleRadioMode: () => void;
  toggleDataSaver: () => void;
  playNext: () => void;
  playPrevious: () => void;
  setQueue: (sermons: Sermon[]) => void;
  stopPlayback: () => void;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [currentSermon, setCurrentSermon] = useState<Sermon | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRadioMode, setIsRadioMode] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [queue, setQueueState] = useState<Sermon[]>(SERMONS);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [dataSaver, setDataSaver] = useState(false);

  const queueRef = useRef(queue);
  queueRef.current = queue;

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

  const playNext = useCallback(() => {
    const nextIdx = (currentIndex + 1) % queueRef.current.length;
    setCurrentIndex(nextIdx);
    setCurrentSermon(queueRef.current[nextIdx]);
    setIsPlaying(true);
    setIsLive(false);
  }, [currentIndex]);

  const playPrevious = useCallback(() => {
    const prevIdx = currentIndex === 0 ? queueRef.current.length - 1 : currentIndex - 1;
    setCurrentIndex(prevIdx);
    setCurrentSermon(queueRef.current[prevIdx]);
    setIsPlaying(true);
    setIsLive(false);
  }, [currentIndex]);

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
      playSermon,
      playLive,
      togglePlay,
      toggleRadioMode,
      toggleDataSaver,
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
      playSermon,
      playLive,
      togglePlay,
      toggleRadioMode,
      toggleDataSaver,
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
