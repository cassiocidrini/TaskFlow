# Lista filas SQS
Write-Host "=== Filas SQS ===" -ForegroundColor Cyan
docker exec taskflow-localstack awslocal sqs list-queues

Write-Host "`n=== Buckets S3 ===" -ForegroundColor Cyan
docker exec taskflow-localstack awslocal s3 ls