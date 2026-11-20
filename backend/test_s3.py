import os
from dotenv import load_dotenv
# pyrefly: ignore[missing-source-for-stubs]
import boto3

# Load variables from .env file if you have python-dotenv installed
load_dotenv()

# Verify environment variables exist
required_vars = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET_NAME"]
missing = [var for var in required_vars if not os.getenv(var)]
if missing:
    print(f"Error: Missing environment variables: {', '.join(missing)}")
    exit(1)

s3 = boto3.client(
    "s3",
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
    region_name=os.getenv("AWS_REGION")
)

try:
    response = s3.list_objects_v2(Bucket=os.getenv("S3_BUCKET_NAME"))
    print("Connection successful! Object count:", response.get("KeyCount", 0))
except Exception as e:
    print("S3 Connection failed:", e)