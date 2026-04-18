import { Router, type IRouter } from "express";
import healthRouter from "./health";
import youtubeRouter from "./youtube";
import adminRouter from "./admin";
import broadcastRouter from "./broadcast";
import authRouter from "./auth";
import userRouter from "./user";
import subscriptionsRouter from "./subscriptions";

const router: IRouter = Router();

router.use(authRouter);
router.use(userRouter);
router.use(healthRouter);
router.use(youtubeRouter);
router.use(adminRouter);
router.use(broadcastRouter);
router.use(subscriptionsRouter);

export default router;
