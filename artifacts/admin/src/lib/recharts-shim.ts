/**
 * recharts-shim.ts
 *
 * Single indirection layer between the admin SPA and the recharts package.
 *
 * WHY THIS EXISTS
 * ───────────────
 * recharts 2.x ships class-component type definitions that don't satisfy
 * React 19's strict JSX element-type checker. The failure is environment-
 * sensitive: pnpm hoisting under local `pnpm install` sometimes hides the
 * mismatch (the dev machine passes `tsc --noEmit`), while Render's install
 * conditions expose it and produce:
 *
 *   TS2786: 'BarChart' cannot be used as a JSX component.
 *   TS2607: JSX element class does not support attributes because it does not
 *           have a 'props' property.
 *
 * Casting each component through `as unknown as ComponentType<any>` breaks
 * the type chain that leads back to the class-component signature, so TypeScript
 * always sees a plain function component — which React 19's JSX checker accepts
 * unconditionally.
 *
 * HOW TO USE
 * ──────────
 *   import { BarChart, Bar, XAxis, ... } from "@/lib/recharts-shim";
 *
 * Never import from "recharts" directly in artifacts/admin/src/*.
 * The `verify:recharts-shim` CI gate enforces this.
 *
 * ADDING NEW COMPONENTS
 * ─────────────────────
 * Re-export the component from recharts using the same cast pattern:
 *   import { Funnel as _Funnel } from "recharts";
 *   export const Funnel = _Funnel as unknown as ComponentType<any>;
 */

import type { ComponentType } from "react";
import {
  ResponsiveContainer as _ResponsiveContainer,
  BarChart as _BarChart,
  Bar as _Bar,
  LineChart as _LineChart,
  Line as _Line,
  AreaChart as _AreaChart,
  Area as _Area,
  ComposedChart as _ComposedChart,
  PieChart as _PieChart,
  Pie as _Pie,
  Cell as _Cell,
  RadarChart as _RadarChart,
  Radar as _Radar,
  ScatterChart as _ScatterChart,
  Scatter as _Scatter,
  XAxis as _XAxis,
  YAxis as _YAxis,
  ZAxis as _ZAxis,
  CartesianGrid as _CartesianGrid,
  Tooltip as _Tooltip,
  Legend as _Legend,
  ReferenceLine as _ReferenceLine,
  ReferenceDot as _ReferenceDot,
  ReferenceArea as _ReferenceArea,
  Label as _Label,
  LabelList as _LabelList,
  PolarGrid as _PolarGrid,
  PolarAngleAxis as _PolarAngleAxis,
  PolarRadiusAxis as _PolarRadiusAxis,
  Brush as _Brush,
  ErrorBar as _ErrorBar,
} from "recharts";

export const ResponsiveContainer = _ResponsiveContainer as unknown as ComponentType<any>;
export const BarChart           = _BarChart           as unknown as ComponentType<any>;
export const Bar                = _Bar                as unknown as ComponentType<any>;
export const LineChart          = _LineChart          as unknown as ComponentType<any>;
export const Line               = _Line               as unknown as ComponentType<any>;
export const AreaChart          = _AreaChart          as unknown as ComponentType<any>;
export const Area               = _Area               as unknown as ComponentType<any>;
export const ComposedChart      = _ComposedChart      as unknown as ComponentType<any>;
export const PieChart           = _PieChart           as unknown as ComponentType<any>;
export const Pie                = _Pie                as unknown as ComponentType<any>;
export const Cell               = _Cell               as unknown as ComponentType<any>;
export const RadarChart         = _RadarChart         as unknown as ComponentType<any>;
export const Radar              = _Radar              as unknown as ComponentType<any>;
export const ScatterChart       = _ScatterChart       as unknown as ComponentType<any>;
export const Scatter            = _Scatter            as unknown as ComponentType<any>;
export const XAxis              = _XAxis              as unknown as ComponentType<any>;
export const YAxis              = _YAxis              as unknown as ComponentType<any>;
export const ZAxis              = _ZAxis              as unknown as ComponentType<any>;
export const CartesianGrid      = _CartesianGrid      as unknown as ComponentType<any>;
export const Tooltip            = _Tooltip            as unknown as ComponentType<any>;
export const Legend             = _Legend             as unknown as ComponentType<any>;
export const ReferenceLine      = _ReferenceLine      as unknown as ComponentType<any>;
export const ReferenceDot       = _ReferenceDot       as unknown as ComponentType<any>;
export const ReferenceArea      = _ReferenceArea      as unknown as ComponentType<any>;
export const Label              = _Label              as unknown as ComponentType<any>;
export const LabelList          = _LabelList          as unknown as ComponentType<any>;
export const PolarGrid          = _PolarGrid          as unknown as ComponentType<any>;
export const PolarAngleAxis     = _PolarAngleAxis     as unknown as ComponentType<any>;
export const PolarRadiusAxis    = _PolarRadiusAxis    as unknown as ComponentType<any>;
export const Brush              = _Brush              as unknown as ComponentType<any>;
export const ErrorBar           = _ErrorBar           as unknown as ComponentType<any>;
