"use strict";

var pathExifMapper = require('path-exif-mapper').PathExifMap;
var uuid = require('node-uuid');
var mime = require('mime');
var AWS = require('aws-sdk');
var fs = require("fs");
var Firebase = require('firebase')


class S3FBFile{
    constructor(path, aws_region, bucket_name, fb_path){
        this.fb_path = fb_path;
        this.path = path;
        this.aws_region = aws_region;
        this.bucket_name = bucket_name;
        this.key = uuid.v1();
        this.content_type = mime.lookup(this.path);
        this.buf = null;
        this.meta_data = null;
    }
    init(){
        return new Promise((p1_res, p1_rej) => {
            Promise.all([
                this.get_file(),
                this.get_meta_data()
            ]).then( (data) => {
                this.buf = data[0];
                this.meta_data = data[1];
                this.upload_to_s3()
                    .then( (s3_data) => {
                        this.upload_to_fb()
                            .then( (fb_data) => {
                                p1_res(this);
                            }, p1_rej);
                    }, p1_rej);
            }, p1_rej);
        });
    }
    get_file(){
        return new Promise( (resolve, reject) => {
            fs.readFile(this.path, (err, buf) => {
    			if(err) reject(err);
    			else resolve(buf);
    		});
        })
    }
    get_meta_data(){
        return new Promise((resolve, reject) => {
            pathExifMapper(this.path, (path, metadata) => {
                resolve(metadata);
            });
        });
    }
    get_url(){
        return `//s3-${this.aws_region}.amazonaws.com/${this.bucket_name}/${this.key}`;
    }
    upload_to_s3(){
        return new Promise((resolve, reject) => {
            try{
                AWS.config.region = this.aws_region;
                var s3bucket = new AWS.S3({params: {Bucket: this.bucket_name}});
                s3bucket.putObject({
        				ACL: 'public-read',
        				Body: this.buf,
        				Key: this.key,
        				ContentType: this.content_type
        			}, function(err, data) {
        			if (err) reject(err);
        			else resolve(data);
        		});
            } catch(ex){
                reject(ex);
            }
        });
    }
    upload_to_fb(){
        return new Promise((resolve, reject) => {
            var data = {
                path: this.get_url(),
                lat: this.lat(),
                lng: this.lng()
            };
            var base = new Firebase(this.fb_path + 'photos/');
            base.push(data, (err, data) => {
                if(err) reject(err);
                else resolve(data);
            });
        });
    }
    lat(){
        var latitude, latitudeRef, decimal;

    	if (!this.meta_data) {
    		throw new Error('Exif Not loaded.');
    	}

    	latitude = this.meta_data.gps && this.meta_data.gps.GPSLatitude;
    	if (!latitude) {
    		return false;
    	}

        decimal = latitude[0] + latitude[1]/60 + latitude[2]/3600;

        latitudeRef = this.meta_data.gps && this.meta_data.gps.GPSLatitudeRef;
    	if (latitudeRef === 'W') {
    		decimal = decimal * -1;
    	}

    	return decimal;
    }
    lng(){
    	var longitude, longitudeRef, decimal;

    	if (!this.meta_data) {
    		throw new Error('Exif Not loaded.');
    	}

    	longitude = this.meta_data.gps && this.meta_data.gps.GPSLongitude;
    	if (!longitude) {
    		return false;
    	}

        decimal = longitude[0] + longitude[1]/60 + longitude[2]/3600;

        longitudeRef = this.meta_data.gps && this.meta_data.gps.GPSLongitudeRef;
    	if (longitudeRef === 'W') {
    		decimal = decimal * -1;
    	}

    	return decimal;
    }
}


module.exports = S3FBFile;
