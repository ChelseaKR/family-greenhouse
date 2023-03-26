import http from "../http-common";

class UserDataService {
/*    getAll(data) {
        return http.get("/users", data);
    }*/

    get(id) {
        return http.get(`/users/${id}`);
    }

    create(data) {
        return http.post("/users/add", data);
    }

    update(id, data) {
        return http.put(`/users/${id}`, data);
    }

    delete(id) {
        return http.delete(`/users/${id}`);
    }

    deleteAll() {
        return http.delete(`/users`);
    }

    findByName(greenhouseId, name) {
        return http.get(`/users?greenhouseId=${greenhouseId}&name=${name}`);
    }

    findByGreenhouseId(greenhouseId) {
        return http.get(`/users?greenhouseId=${greenhouseId}`);
    }
}

export default new UserDataService();