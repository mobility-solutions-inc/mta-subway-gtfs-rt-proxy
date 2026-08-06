import type { MetricDatum } from '@aws-sdk/client-cloudwatch'
import {
	CloudWatchClient,
	PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch'

import { createLogger } from './logger.js'

const configuredNamespace =
	process.env.CLOUDWATCH_METRICS_NAMESPACE?.trim() ?? ''
const namespace = configuredNamespace === '' ? null : configuredNamespace
const logger = createLogger(
	'cloudwatch-metrics',
	process.env.LOG_LEVEL ?? 'info',
)

let client: CloudWatchClient | null = null

const publishCloudWatchMetrics = async (metricData: MetricDatum[]) => {
	if (namespace === null) return
	client ??= new CloudWatchClient({})
	try {
		await client.send(
			new PutMetricDataCommand({
				Namespace: namespace,
				MetricData: metricData,
			}),
		)
	} catch (error) {
		logger.warn(
			{ error, metricNames: metricData.map(({ MetricName }) => MetricName) },
			'failed to publish CloudWatch metrics',
		)
	}
}

const feedNameDimension = (feedName: string) => [
	{ Name: 'FeedName', Value: feedName },
]

export { feedNameDimension, publishCloudWatchMetrics }
