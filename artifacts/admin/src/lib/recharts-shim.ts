import type { ComponentType } from "react";
import {
  Area as RawArea,
  AreaChart as RawAreaChart,
  CartesianGrid as RawCartesianGrid,
  ResponsiveContainer as RawResponsiveContainer,
  Tooltip as RawTooltip,
  XAxis as RawXAxis,
  YAxis as RawYAxis,
} from "recharts";

export const Area = RawArea as unknown as ComponentType<any>;
export const AreaChart = RawAreaChart as unknown as ComponentType<any>;
export const CartesianGrid = RawCartesianGrid as unknown as ComponentType<any>;
export const ResponsiveContainer = RawResponsiveContainer as unknown as ComponentType<any>;
export const Tooltip = RawTooltip as unknown as ComponentType<any>;
export const XAxis = RawXAxis as unknown as ComponentType<any>;
export const YAxis = RawYAxis as unknown as ComponentType<any>;
