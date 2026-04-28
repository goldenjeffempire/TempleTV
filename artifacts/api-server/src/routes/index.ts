import { Router, type IRouter } from "express";
import healthRouter from "./health";
import youtubeRouter from "./youtube";
import adminRouter from "./admin";
import broadcastRouter from "./broadcast";
import playbackRouter from "./playback";
import authRouter from "./auth";
import deviceLinkRouter from "./device-link";
import userRouter from "./user";
import clientErrorsRouter from "./client-errors";

const router: IRouter = Router();

router.use(authRouter);
router.use(deviceLinkRouter);
router.use(userRouter);
router.use(healthRouter);
router.use(youtubeRouter);
router.use(adminRouter);
router.use(broadcastRouter);
router.use(playbackRouter);
router.use(clientErrorsRouter);

export default router;
