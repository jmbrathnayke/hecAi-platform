import os
import uuid
import boto3
from werkzeug.utils import secure_filename

s3_client = boto3.client(
    "s3",
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
    region_name=os.getenv("AWS_REGION")
)

BUCKET_NAME = os.getenv("S3_BUCKET_NAME")

def upload_damage_photo(file_obj, subfolder="damage-records"):
    """
    Uploads a file object to S3 and returns the generated S3 key and presigned URL.
    """
    clean_name = secure_filename(file_obj.filename)
    unique_key = f"{subfolder}/{uuid.uuid4()}_{clean_name}"
    
    s3_client.upload_fileobj(
        file_obj,
        BUCKET_NAME,
        unique_key,
        ExtraArgs={"ContentType": file_obj.content_type}
    )
    
    # Generate a temporary presigned URL (valid for 1 hour) so the frontend can display it
    presigned_url = s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET_NAME, "Key": unique_key},
        ExpiresIn=3600
    )
    
    return unique_key, presigned_url